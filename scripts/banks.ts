/** Short names you can type instead of a bank code. */
export const BANK_ALIASES: Record<string, string> = {
  // Комерцијална банка
  komercijalna: '300',
  komercijana: '300',
  kb: '300',
  комерцијална: '300',
  // Стопанска банка
  stopanska: '200',
  sb: '200',
  стопанска: '200',
  // НЛБ Банка
  nlb: '210',
  нлб: '210',
  // Халк Банка
  halk: '270',
  halkbank: '270',
  халк: '270',
  // Шпаркасе
  sparkase: '250',
  sparkasse: '250',
  shparkase: '250',
  шпаркасе: '250',
  // ProCredit
  procredit: '380',
  pcb: '380',
  прокредит: '380',
  // УНИБанка
  unibanka: '240',
  uni: '240',
  унибанка: '240',
  // ТТК Банка
  ttk: '290',
  ттк: '290',
  // Централна кооперативна
  ckb: '320',
  centralna: '320',
  цкб: '320',
  централна: '320',
  // Развојна банка
  razvojna: '100',
  rbsm: '100',
  развојна: '100',
  // Silk Road Bank
  silkroad: '330',
  silk: '330',
  sr: '330',
};

/** Display name per bank code, short enough for a table. */
export const BANK_SHORT_NAMES: Record<string, string> = {
  '300': 'Комерцијална',
  '200': 'Стопанска',
  '210': 'НЛБ',
  '270': 'Халк',
  '250': 'Шпаркасе',
  '380': 'ProCredit',
  '240': 'УНИБанка',
  '290': 'ТТК',
  '320': 'ЦКБ',
  '100': 'Развојна',
  '330': 'Silk Road',
};

/** The canonical alias to suggest for each bank code. */
export const PRIMARY_ALIASES: Record<string, string> = {
  '300': 'komercijalna',
  '200': 'stopanska',
  '210': 'nlb',
  '270': 'halk',
  '250': 'sparkase',
  '380': 'procredit',
  '240': 'unibanka',
  '290': 'ttk',
  '320': 'ckb',
  '100': 'razvojna',
  '330': 'silkroad',
};

export function bankCodeFromAlias(token: string): string | undefined {
  return BANK_ALIASES[token.toLowerCase().replace(/[\s.-]/g, '')];
}

export function isBankAlias(token: string): boolean {
  return bankCodeFromAlias(token) !== undefined;
}
