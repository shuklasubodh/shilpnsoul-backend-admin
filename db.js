import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
const url=process.env.DATABASE_URL||process.env.POSTGRES_URL;
if(!url||/@host\/database|your_neon_host/.test(url))throw new Error('A valid DATABASE_URL must be configured');
export default neon(url);
