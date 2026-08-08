import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

let client;
const getClient=()=>{
  if(client)return client;
  const url=process.env.DATABASE_URL||process.env.POSTGRES_URL;
  if(!url||/@host\/database|your_neon_host/.test(url)){
    const error=new Error('DATABASE_URL is not configured for this deployment.');
    error.code='DATABASE_URL_MISSING';
    throw error;
  }
  client=neon(url);
  return client;
};

const sql=(strings,...values)=>getClient()(strings,...values);
sql.query=(text,params)=>getClient().query(text,params);
export default sql;
