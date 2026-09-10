export const notificationChannels=['EMAIL','SMS','WHATSAPP'];

export const resolveNotificationChannel=({customer,email,requestedChannel,preferredChannel})=>{
  const requested=String(requestedChannel||preferredChannel||'').toUpperCase();
  return !customer&&email?'EMAIL':requested;
};

export const verificationMatches=({claims,channel,destination,purpose='CHECKOUT'})=>Boolean(
  claims&&claims.type==='notification-verification'&&claims.purpose===purpose&&
  claims.channel===channel&&claims.destination===destination
);

export const returnDeadlineOpen=({deliveredAt,windowDays=2,now=Date.now()})=>{
  const delivered=new Date(deliveredAt).getTime();
  return Number.isFinite(delivered)&&now<=delivered+Number(windowDays)*86400000;
};
