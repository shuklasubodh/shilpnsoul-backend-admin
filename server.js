import express from'express';import cors from'cors';import'dotenv/config';
import sql from'./db.js';
import login from'./login.js';
import users from'./users.js';
import catalog from'./categories.js';
import carts from'./carts.js';
import orders from'./orders.js';
import payments,{stripeWebhook}from'./payments.js';
import notifications from'./notifications.js';
import whatsapp from'./whatsapp.js';
import productDescriptions from'./productDescriptions.js';
import adminApi from'./admin.js';
import marketing from'./marketing.js';

const defaultOrigins='http://localhost:5173,https://shilnsoul-react-admin.vercel.app,https://shilpnsoul-react-fe.vercel.app,https://shilpnsoul.com,https://www.shilpnsoul.com';

const normalizeOrigin=value=>String(value||'').trim().replace(/\/$/,'');
const app=express(),origins=[...new Set(`${defaultOrigins},${process.env.CORS_ORIGINS||''}`.split(',').map(normalizeOrigin).filter(Boolean))];

app.use(cors({origin:(origin,callback)=>!origin||origins.includes(normalizeOrigin(origin))?callback(null,true):callback(new Error('CORS origin denied')),exposedHeaders:['X-Total-Count']}));
app.use('/api/payments/stripe/webhook',stripeWebhook);
app.use(express.json({limit:'4mb',verify:(req,res,buffer)=>{if(req.originalUrl?.startsWith('/api/whatsapp/webhook'))req.rawBody=Buffer.from(buffer)}}));

app.use('/api/admin',productDescriptions);
app.use('/api/admin',(req,res)=>{const request=Object.create(req);Object.defineProperty(request,'query',{value:{...req.query,route:String(req.path||'').replace(/^\/+|\/+$/g,'')}});return adminApi(request,res)});

app.get('/api/health',async(req,res)=>{await sql`SELECT 1`;res.json({status:'ok',database:'connected'})});

app.use('/api',login);
app.use('/api',marketing);
app.use('/api',notifications);
app.use('/api',whatsapp);
app.use('/api',productDescriptions);
app.use('/api/users',users);
app.use('/api',catalog);
app.use('/api',carts);
app.use('/api',orders);
app.use('/api/payments',payments);

app.use((req,res)=>res.status(404).json({error:'Endpoint not found.'}));
app.use((error,req,res,next)=>{if(res.headersSent)return next(error);console.error(error);
    if(error.code==='DATABASE_URL_MISSING')return res.status(503).json({error:'Database connection is not configured for this deployment.'});
    if(error.code==='STRIPE_CONFIG_MISSING')return res.status(503).json({error:error.message});
    if(error.code==='STRIPE_ACCOUNT_MISMATCH')return res.status(503).json({error:'Stripe account verification failed.'});
    if(error.code==='WHATSAPP_CONFIG_MISSING')return res.status(503).json({error:error.message});
    if(error.code==='SMS_CONFIG_MISSING')return res.status(503).json({error:error.message});
    if(error.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:'The uploaded document exceeds the 10 MB limit.'});
    if(error.message==='Only .docx and .xlsx files are supported.')return res.status(400).json({error:error.message});
    if(error.message==='CORS origin denied')return res.status(403).json({error:error.message});
    if(error.code==='23505')return res.status(409).json({error:'Duplicate value.'});
    if(error.code==='23503')return res.status(409).json({error:'Record is referenced.'});return res.status(500).json({error:'Internal server error.'})});
if(process.env.NODE_ENV!=='production'){const port=Number(process.env.PORT)||3000;app.listen(port,()=>console.log(`API listening on ${port}`))}export default app;
