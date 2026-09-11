/**
 * Seeded data for Meridian Core.
 *
 * Entirely fabricated. Three things here are deliberate:
 *
 *  - The CANARY_* values are planted so that tests/safety/ can push them through
 *    a full run and then grep every byte of evidence/ and artifacts/ for them.
 *    A redaction claim nobody tested is a redaction claim that is false.
 *  - `078-05-1120` is the Woolworth wallet number: famously invalid as a real
 *    SSN, correctly shaped for a redaction pattern to catch. Using a plausible
 *    random SSN in test data would be careless in a way this project is
 *    specifically about not being.
 *  - `4111111111111111` is the standard Visa test number. Valid Luhn, so it
 *    exercises the card redactor's checksum path.
 */

export const CANARY_SSN = '078-05-1120';
export const CANARY_CARD = '4111111111111111';
export const CANARY_PASSWORD = 'CANARY-PWD-do-not-log-7f3a91';
export const CANARY_NOTE = 'CANARY-MEMO-never-persist-b2e4c8';

export interface Account {
  number: string;
  type: 'Savings' | 'Checking' | 'Money Market' | 'Certificate';
  status: 'Active' | 'Dormant' | 'Restricted';
  balance: number;
  opened: string;
}

export interface Member {
  id: string;
  name: string;
  status: 'Active' | 'Restricted' | 'Closed';
  joined: string;
  ssn: string;
  card: string;
  /** Free-text servicing memo. Carries a canary; must never reach evidence. */
  memo: string;
  accounts: Account[];
}

export const OPERATOR = { username: 'teller01', password: CANARY_PASSWORD };

export const MEMBERS: Member[] = [
  {
    id: '12345',
    name: 'Jordan Avery',
    status: 'Active',
    joined: '2014-03-08',
    ssn: CANARY_SSN,
    card: CANARY_CARD,
    memo: `Prefers paperless statements. ${CANARY_NOTE}`,
    accounts: [
      { number: '0001-4477', type: 'Savings',      status: 'Active',  balance: 4210.55, opened: '2014-03-08' },
      { number: '0002-9910', type: 'Checking',     status: 'Active',  balance: 1832.09, opened: '2014-03-08' },
      { number: '0003-2256', type: 'Money Market', status: 'Dormant', balance: 15000.00, opened: '2019-11-22' },
    ],
  },
  {
    id: '67890',
    name: 'Priya Raman',
    status: 'Active',
    joined: '2021-07-19',
    ssn: '078-05-1121',
    card: '4012888888881881',
    memo: 'Joint account holder pending verification.',
    accounts: [
      { number: '0004-8831', type: 'Savings',     status: 'Active', balance: 927.40, opened: '2021-07-19' },
      { number: '0005-1177', type: 'Certificate', status: 'Active', balance: 25000.00, opened: '2023-01-05' },
    ],
  },
  {
    // Exists, but servicing is restricted. The interesting case: this is NOT a
    // "not found", and it is NOT a crash. It is a third answer, and a caller
    // that only models success/failure has nowhere to put it.
    id: '55555',
    name: 'Dana Whitfield',
    status: 'Restricted',
    joined: '2009-02-14',
    ssn: '078-05-1122',
    card: '4222222222222',
    memo: 'Account under review by compliance. Do not service without approval.',
    accounts: [
      { number: '0006-3390', type: 'Savings', status: 'Restricted', balance: 88.12, opened: '2009-02-14' },
    ],
  },
];

export function findMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id.trim());
}

/** Every canary planted in this dataset, for the safety test to hunt. */
export const ALL_CANARIES = [
  CANARY_SSN, CANARY_CARD, CANARY_PASSWORD, CANARY_NOTE,
  '078-05-1121', '078-05-1122', '4012888888881881',
];
