export const notificationChannels=['EMAIL','SMS','WHATSAPP'];

export const validCheckoutId=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||''));

export const normalizeOwnershipContacts=contacts=>{
  if(!contacts||typeof contacts!=='object'||Array.isArray(contacts))return null;
  const keys=Object.keys(contacts);
  if(!keys.length||keys.some(key=>!notificationChannels.includes(String(key).toUpperCase())))return null;
  const email=String(contacts.EMAIL||contacts.email||'').trim().toLowerCase();
  const normalizePhone=value=>{
    const raw=String(value||'').trim();
    if(!raw)return'';
    const normalized=`+${raw.replace(/\D/g,'')}`;
    return /^\+[1-9]\d{7,14}$/.test(normalized)?normalized:null;
  };
  const sms=normalizePhone(contacts.SMS||contacts.sms),whatsapp=normalizePhone(contacts.WHATSAPP||contacts.whatsapp);
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||sms===null||whatsapp===null)return null;
  const phones=[...new Set([sms,whatsapp].filter(Boolean))];
  return email||phones.length?{email,phones}:null;
};

export const verificationChannelsFor=({email,phone,whatsapp})=>[
  ...(email?['EMAIL']:[]),
  ...(phone?['SMS']:[]),
  ...(whatsapp?['WHATSAPP']:[]),
];

export const notificationChannelsFor=({requestedChannels=[],availableChannels=[]})=>{
  const channels=[...new Set(['EMAIL',...requestedChannels.map(value=>String(value).toUpperCase())])];
  if(channels.some(channel=>!notificationChannels.includes(channel)||!availableChannels.includes(channel)))throw new Error('Every selected notification channel must have a verified contact.');
  return channels;
};

export const verificationMatches=({claims,channel,destination,purpose='CHECKOUT',subjectType,subjectId})=>Boolean(
  claims&&claims.type==='notification-verification'&&claims.purpose===purpose&&
  claims.channel===channel&&claims.destination===destination&&
  (!subjectType||claims.subject_type===subjectType)&&
  (!subjectId||String(claims.subject_id)===String(subjectId))
);

export const returnDeadlineOpen=({deliveredAt,windowDays=2,now=Date.now()})=>{
  const delivered=new Date(deliveredAt).getTime();
  return Number.isFinite(delivered)&&now<=delivered+Number(windowDays)*86400000;
};
