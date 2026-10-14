export const notificationChannels=['EMAIL','SMS','WHATSAPP'];

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
