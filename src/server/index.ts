import { onClientCallback } from '@overextended/ox_lib/server';
import type {
  AccessTableData,
  Account,
  DashboardData,
  InvoicesFilters,
  LogsFilters,
  RawLogItem,
  Transaction,
} from '../common/typings';
import { oxmysql } from '@overextended/oxmysql';
import { Ox, GetPlayer } from '@overextended/ox_core/server';
import type { DateRange } from 'react-day-picker';

onClientCallback('ox_banking:getAccounts', async (playerId): Promise<Account[]> => {
  const player = GetPlayer(playerId);

  if (!player) return;

  const accessAccounts = await player.getAccounts(true);

  const accounts: Account[] = accessAccounts.map((account) => ({
    group: account.group,
    id: account.id,
    label: account.label,
    isDefault: player.charId === account.owner ? account.isDefault : false,
    balance: account.balance,
    type: account.type,
    owner: account.ownerName,
    role: account.role,
  }));

  return accounts;
});

onClientCallback('ox_banking:createAccount', async (playerId, { name, shared }: { name: string; shared: boolean }) => {
  const { charId } = GetPlayer(playerId);

  if (!charId) return;

  return await Ox.CreateAccount(charId, name, shared);
});

onClientCallback('ox_banking:deleteAccount', async (playerId, accountId: number) => {
  const player = GetPlayer(playerId);
  const account = await Ox.GetAccountById(accountId);

  if (!account || !player) return;

  if (account.balance > 0) return;

  const hasPermission = await player.hasAccountPermission(accountId, 'closeAccount');

  if (!hasPermission) return;

  return await Ox.DeleteAccount(accountId);
});

interface UpdateBalance {
  accountId: number;
  amount: number;
}

interface TransferBalance {
  fromAccountId: number;
  target: string | number;
  transferType: 'account' | 'person';
  amount: number;
}

onClientCallback('ox_banking:depositMoney', async (playerId, { accountId, amount }: UpdateBalance) => {
  const response = await Ox.DepositMoney(playerId, accountId, amount);
  //@todo notify
  return response === true;
});

onClientCallback('ox_banking:withdrawMoney', async (playerId, { accountId, amount }: UpdateBalance) => {
  console.log(accountId, amount);
  const response = await Ox.WithdrawMoney(playerId, accountId, amount);
  //@todo notify
  return response === true;
});

onClientCallback(
  'ox_banking:transferMoney',
  async (playerId, { fromAccountId, target, transferType, amount }: TransferBalance) => {
    const player = GetPlayer(playerId);

    if (!(await player?.hasAccountPermission(fromAccountId, 'withdraw'))) return;

    const targetAccountId =
      transferType === 'account' ? (target as number) : (await Ox.GetCharacterAccount(target))?.id;

    if (targetAccountId) {
      const response = await Ox.TransferAccountBalance({
        fromId: fromAccountId,
        toId: targetAccountId,
        amount: amount,
        actorId: player.charId,
      });
      //@todo notify
      return response === true;
    }
  }
);

onClientCallback('ox_banking:getDashboardData', async (playerId): Promise<DashboardData> => {
  const account = await GetPlayer(playerId)?.getAccount();

  if (!account) return;

  const overview = await oxmysql.rawExecute<
    {
      day: string;
      income: number;
      expenses: number;
    }[]
  >(
    `
    SELECT
      DAYNAME(d.date) as day,
      CAST(COALESCE(SUM(CASE WHEN at.toId = ? THEN at.amount ELSE 0 END), 0) AS UNSIGNED) as income,
      CAST(COALESCE(SUM(CASE WHEN at.fromId = ? THEN at.amount ELSE 0 END), 0) AS UNSIGNED) as expenses
    FROM (
      SELECT CURDATE() as date
      UNION ALL SELECT DATE_SUB(CURDATE(), INTERVAL 1 DAY)
      UNION ALL SELECT DATE_SUB(CURDATE(), INTERVAL 2 DAY)
      UNION ALL SELECT DATE_SUB(CURDATE(), INTERVAL 3 DAY)
      UNION ALL SELECT DATE_SUB(CURDATE(), INTERVAL 4 DAY)
      UNION ALL SELECT DATE_SUB(CURDATE(), INTERVAL 5 DAY)
      UNION ALL SELECT DATE_SUB(CURDATE(), INTERVAL 6 DAY)
    ) d
    LEFT JOIN accounts_transactions at ON d.date = DATE(at.date) AND (at.toId = ? OR at.fromId = ?)
    GROUP BY d.date
    ORDER BY d.date ASC
    `,
    [account.id, account.id, account.id, account.id]
  );

  const lastTransactions = await oxmysql.rawExecute<
    {
      amount: number;
      date: string;
      toId?: number;
      fromId?: number;
      message?: string;
    }[]
  >(
    `
    SELECT amount, DATE_FORMAT(date, '%Y-%m-%d %H:%i') as date, toId, fromId, message
    FROM accounts_transactions
    WHERE toId = ? OR fromId = ?
    ORDER BY id DESC
    LIMIT 5
    `,
    [account.id, account.id]
  );

  const transactions: Transaction[] = lastTransactions.map((transaction) => {
    return {
      amount: transaction.amount,
      date: transaction.date,
      message: transaction.message,
      type: transaction.toId === account.id ? 'inbound' : 'outbound',
    };
  });

  return {
    balance: account.balance,
    overview,
    transactions,
    invoices: [],
  };
});

onClientCallback(
  'ox_banking:getAccountUsers',
  async (
    playerId,
    data: {
      accountId: number;
      page: number;
      search?: string;
    }
  ): Promise<AccessTableData> => {
    const { accountId, page, search } = data;
    const player = GetPlayer(playerId);

    if (!player) return;
    if (!(await player.hasAccountPermission(accountId, 'manageUser'))) return;

    const wildcard = `%${search}%`;

    const users = await oxmysql.rawExecute<AccessTableData['users']>(
      `
      SELECT c.stateId, a.role, CONCAT(c.firstName, " ", c.lastName) AS \`name\` FROM \`accounts_access\` a
      LEFT JOIN \`characters\` c ON c.charId = a.charId
      WHERE a.accountId = ?
      AND CONCAT(c.firstName, " ", c.lastName) LIKE ?
      ORDER BY a.role DESC
      LIMIT 7
      OFFSET ?
      `,
      [accountId, wildcard, page * 7]
    );

    const usersCount = await oxmysql.prepare<number>(
      'SELECT COUNT(*) FROM `accounts_access` ac LEFT JOIN characters c ON c.charId = ac.charId WHERE accountId = ? AND CONCAT(c.firstName, " ", c.lastName) LIKE ?',
      [accountId, wildcard]
    );

    return {
      numberOfPages: Math.ceil(usersCount / 7),
      users,
    };
  }
);

onClientCallback(
  'ox_banking:addUserToAccount',
  async (
    playerId,
    {
      accountId,
      stateId,
      role,
    }: {
      accountId: number;
      stateId: string;
      role: string;
    }
  ) => {
    const player = GetPlayer(playerId);

    if (!(await player?.hasAccountPermission(accountId, 'addUser'))) return;

    const success = await oxmysql.prepare('SELECT 1 FROM `characters` WHERE `stateId` = ?', [stateId]);

    if (!success) return 'state_id_not_exists';

    return await Ox.SetAccountAccess(accountId, stateId, role);
  }
);

onClientCallback(
  'ox_banking:manageUser',
  async (
    playerId,
    data: {
      accountId: number;
      targetStateId: string;
      values: { role: string };
    }
  ): Promise<boolean> => {
    const player = GetPlayer(playerId);

    if (!(await player?.hasAccountPermission(data.accountId, 'manageUser'))) return;

    return (await Ox.SetAccountAccess(data.accountId, data.targetStateId, data.values.role)) > 0;
  }
);

onClientCallback('ox_banking:removeUser', async (playerId, data: { targetStateId: string; accountId: number }) => {
  const player = GetPlayer(playerId);

  if (!(await player?.hasAccountPermission(data.accountId, 'removeUser'))) return;

  return await Ox.RemoveAccountAccess(data.accountId, data.targetStateId);
});

onClientCallback(
  'ox_banking:transferOwnership',
  async (
    playerId,
    data: {
      targetStateId: string;
      accountId: number;
    }
  ): Promise<true | 'state_id_not_exists'> => {
    const player = GetPlayer(playerId);

    if (!(await player?.hasAccountPermission(data.accountId, 'transferOwnership'))) return;

    const targetCharId = await oxmysql.prepare<number | null>('SELECT `charId` FROM `characters` WHERE `stateId` = ?', [
      data.targetStateId,
    ]);

    if (!targetCharId) return 'state_id_not_exists';

    await oxmysql.prepare(
      "INSERT INTO `accounts_access` (`accountId`, `charId`, `role`) VALUES (?, ?, 'owner') ON DUPLICATE KEY UPDATE `role` = 'owner'",
      [data.accountId, targetCharId]
    );

    await oxmysql.prepare('UPDATE `accounts` SET `owner` = ? WHERE `id` = ?', [targetCharId, data.accountId]);

    await oxmysql.prepare("UPDATE `accounts_access` SET `role` = 'manager' WHERE `accountId` = ? AND `charId` = ?", [
      data.accountId,
      player.charId,
    ]);

    return true;
  }
);

onClientCallback('ox_banking:renameAccount', async (playerId, data: { accountId: number; name: string }) => {
  const player = GetPlayer(playerId);

  if (!player) return;

  const hasPermission = await player.hasAccountPermission(data.accountId, 'manageAccount');
  if (!hasPermission) return false;

  await oxmysql.prepare('UPDATE `accounts` SET `label` = ? WHERE `id` = ?', [data.name, data.accountId]);

  return true;
});

onClientCallback('ox_banking:convertAccountToShared', async (playerId, data: { accountId: number }) => {
  const player = GetPlayer(playerId);

  if (!player) return;

  const account = await Ox.GetAccountById(data.accountId);

  if (account.type !== 'personal') return;
  if (account.owner !== player.charId) return;

  await oxmysql.prepare('UPDATE `accounts` SET `type` = ? WHERE `id` = ?', ['shared', data.accountId]);

  return true;
});

onClientCallback('ox_banking:getLogs', async (playerId, data: { accountId: number; filters: LogsFilters }) => {
  const player = GetPlayer(playerId);

  if (!player) return;

  const hasPermission = await player.hasAccountPermission(data.accountId, 'viewHistory');

  if (!hasPermission) return;

  const { accountId, filters } = data;

  const search = `%${filters.search}%`;

  let dateSearchString = '';
  let queryParams: any[] = [accountId, accountId, search, search];

  let typeQueryString = ``;

  if (filters.type && filters.type !== 'combined') {
    typeQueryString += 'AND (';
    filters.type === 'outbound' ? (typeQueryString += 'fromAccount = ?)') : (typeQueryString += 'toAccount = ?)');

    queryParams.push(accountId);
  }

  if (filters.date) {
    const date = getFormattedDates(filters.date);

    dateSearchString = `AND (DATE(ac.date) BETWEEN ? AND ?)`;
    queryParams.push(date.from, date.to);
  }

  const queryWhere = `WHERE (fromAccount = ? OR toAccount = ?) AND (ac.message LIKE ? OR CONCAT(c.firstName, ' ', c.lastName) LIKE ?) ${typeQueryString} ${dateSearchString}`;
  const countQueryParams = [...queryParams];

  queryParams.push(filters.page * 9);

  const queryData = await oxmysql.rawExecute<RawLogItem[]>(
    `
          SELECT ac.id, ac.toId, ac.fromBalance, ac.toBalance, ac.message, ac.amount, DATE_FORMAT(ac.date, '%Y-%m-%d %H:%i') AS date, CONCAT(c.firstName, ' ', c.lastName) AS name
          FROM accounts_transactions ac
          LEFT JOIN characters c ON c.charId = ac.actorId
          ${queryWhere}
          ORDER BY ac.id DESC
          LIMIT 9
          OFFSET ?
        `,
    queryParams
  );

  const totalLogsCount = await oxmysql.prepare(
    `
          SELECT COUNT(*)
          FROM accounts_transactions ac
          LEFT JOIN characters c ON c.charId = ac.actorId
          ${queryWhere}
        `,
    countQueryParams
  );

  return {
    numberOfPages: Math.ceil(totalLogsCount / 9),
    logs: queryData,
  };
});

onClientCallback('ox_banking:getInvoices', async (playerId, data: { accountId: number; filters: InvoicesFilters }) => {
  const player = GetPlayer(playerId);

  if (!player) return;

  const { accountId, filters } = data;

  const hasPermission = await player.hasAccountPermission(accountId, 'payInvoice');

  if (!hasPermission) return;

  const search = `%${filters.search}%`;

  let queryParams: any[] = [];

  let dateSearchString = '';
  let columnSearchString = '';
  let typeSearchString = '';

  let query = '';
  let queryJoins = '';

  switch (filters.type) {
    case 'unpaid':
      typeSearchString = '(ai.toAccount = ? AND ai.paidAt IS NULL)';
      columnSearchString = '(a.label LIKE ? OR ai.message LIKE ?)';

      queryParams.push(accountId, search, search);

      queryJoins = `
        LEFT JOIN accounts a ON ai.fromAccount = a.id
        LEFT JOIN characters c ON ai.actorId = c.charId
      `;

      query = `
          SELECT
            ai.id,
            a.label,
            ai.amount,
            ai.message,
            DATE_FORMAT(ai.dueDate, '%Y-%m-%d %H:%i') as dueDate,
            'unpaid' AS type
          FROM accounts_invoices ai
          ${queryJoins}
      `;

      break;
    case 'paid':
      typeSearchString = '(ai.toAccount = ? AND ai.paidAt IS NOT NULL)';
      columnSearchString = `(CONCAT(c.firstName, ' ', c.lastName) LIKE ? OR ai.message LIKE ?)`;

      queryParams.push(accountId, search, search);

      queryJoins = `
        LEFT JOIN accounts a ON ai.fromAccount = a.id
        LEFT JOIN characters c ON ai.payerId = c.charId
      `;

      query = `
        SELECT
          ai.id,
          CONCAT(c.firstName, ' ', c.lastName) as paidBy,
          a.label,
          ai.amount,
          ai.message,
          DATE_FORMAT(ai.dueDate, '%Y-%m-%d %H:%i') as dueDate,
          DATE_FORMAT(ai.paidAt, '%Y-%m-%d %H:%i') as paidAt,
          'paid' AS type
        FROM accounts_invoices ai
        ${queryJoins}
      `;

      break;
    case 'sent':
      typeSearchString = '(ai.fromAccount = ?)';
      columnSearchString = `(CONCAT(c.firstName, ' ', c.lastName) LIKE ? OR ai.message LIKE ? OR a.label LIKE ?)`;

      queryParams.push(accountId, search, search, search);

      queryJoins = `
        LEFT JOIN accounts a ON ai.toAccount = a.id
        LEFT JOIN characters c ON ai.actorId = c.charId
      `;

      query = `
        SELECT
          ai.id,
          CONCAT(c.firstName, ' ', c.lastName) as sentBy,
          a.label,
          ai.amount,
          ai.message,
          DATE_FORMAT(ai.sentAt, '%Y-%m-%d %H:%i') as sentAt,
          DATE_FORMAT(ai.dueDate, '%Y-%m-%d %H:%i') as dueDate,
          CASE
            WHEN ai.payerId IS NOT NULL THEN 'paid'
            WHEN NOW() > ai.dueDate THEN 'overdue'
            ELSE 'sent'
          END AS status,
          'sent' AS type
        FROM accounts_invoices ai
        ${queryJoins}
      `;

      break;
  }

  if (filters.date) {
    const date = getFormattedDates(filters.date);

    // todo: fix date filtering
    dateSearchString = `AND (DATE(ai.sentAt) BETWEEN ? AND ?)`;
    queryParams.push(date.from, date.to);
  }

  const whereStatement = `WHERE ${typeSearchString} AND ${columnSearchString} ${dateSearchString}`;

  queryParams.push(filters.page * 6);

  const result = await oxmysql
    .rawExecute(
      `
    ${query}
    ${whereStatement}
    ORDER BY ai.id DESC
    LIMIT 6
    OFFSET ?
  `,
      queryParams
    )
    .catch((e) => console.log(e));

  queryParams.pop();
  const totalInvoices = await oxmysql
    .prepare(
      `
        SELECT COUNT(*)
        FROM accounts_invoices ai
        ${queryJoins}
        ${whereStatement}`,
      queryParams
    )
    .catch((e) => console.log(e));
  const numberOfPages = Math.ceil(totalInvoices / 6);

  return {
    invoices: result,
    numberOfPages,
  };
});

function getFormattedDates(date: DateRange) {
  const rawDates = {
    from: new Date(date.from),
    to: new Date(date.to ?? date.from),
  };

  const formattedDates = {
    from: new Date(
      Date.UTC(rawDates.from.getFullYear(), rawDates.from.getMonth(), rawDates.from.getDate(), 0, 0, 0)
    ).toISOString(),
    to: new Date(
      Date.UTC(rawDates.to.getFullYear(), rawDates.to.getMonth(), rawDates.to.getDate(), 23, 59, 59)
    ).toISOString(),
  };

  return formattedDates;
}
