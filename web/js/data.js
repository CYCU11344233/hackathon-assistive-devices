// 中心名稱、開放時間、地址、電話：臺北市二手輔具資源提供單位（臺北市政府社會局，政府資料開放授權條款第1版）
//   https://data.gov.tw/dataset/135817 ，2026-11-07 下載
// 入口提示：臺北市二手輔具借用須知 https://tpap.taipei/app37/rentView/intaipei
// 座標：OpenStreetMap Nominatim 依地址查詢（© OpenStreetMap contributors, ODbL）；合宜中心只查到玉門街 1 號園區，為約略位置。
export const CENTERS = [
  {
    id: 'heyi',
    name: '臺北市合宜輔具中心',
    hoursText: '周二至周六 9:00-12:00 13:30-17:00',
    address: '臺北市中山區玉門街1號',
    district: '中山區',
    phone: '0277137760',
    phoneText: '(02)7713-7760',
    lat: 25.0695,
    lng: 121.5212,
    approx: true,
    entrance: '位於花博公園（玉門街 1 號）園區內，位置為約略標示。',
  },
  {
    id: 'south',
    name: '臺北市南區輔具中心',
    hoursText: '周一至周五 9:00-12:00 13:30-17:00',
    address: '臺北市信義區大道路116號3樓之2',
    district: '信義區',
    phone: '0227207364',
    phoneText: '(02)2720-7364',
    lat: 25.0386,
    lng: 121.5829,
    approx: false,
    entrance: '在廣慈衛福大樓，請從西 2 門的 B 電梯廳進入。',
  },
  {
    id: 'west',
    name: '臺北市西區輔具中心',
    hoursText: '周二至周六 9:00-12:00 13:30-17:00',
    address: '臺北市中山區長安西路5巷2號1、2樓',
    district: '中山區',
    phone: '0225237902',
    phoneText: '(02)2523-7902',
    lat: 25.0505,
    lng: 121.5208,
    approx: false,
    entrance: '在臺北市政府衛生局舊址後方。',
  },
];

// 須知列出的可借用項目
export const ITEMS = [
  '輪椅', '助行器', '拐杖', '便盆椅', '輪椅座墊', '氣墊床',
  '洗澡椅', '助步車', '居家用照顧床', '移位輔具', '矯具',
];

export const LINKS = {
  reserve: 'https://tpap.taipei/app37/rentView/intaipei',
  chooseCounty: 'https://tpap.taipei/app37/rentView/chooseCntcode',
  query: 'https://tpap.taipei/app37/rentView/query',
  stairEval: 'https://tpap.taipei/app37/otherReserveView/where',
  dataset: 'https://data.gov.tw/dataset/135817',
  ltc: '1966',
};

export const CHECKLISTS = {
  pickup: [
    '帶身分證正本',
    '開館時間內到（12:00–13:30 午休）',
    '想好怎麼載回家',
    '記下借用單上的歸還日',
  ],
  return: [
    '用 75% 酒精消毒、晾乾',
    '開館時間內送回',
    '有損壞先打電話給中心',
  ],
};
