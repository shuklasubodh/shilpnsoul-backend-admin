import express from'express';import cors from'cors';import'dotenv/config';
import sql from'./db.js';
import login from'./login.js';
import users from'./users.js';
import catalog from'./categories.js';
import carts from'./carts.js';
import orders from'./orders.js';

const defaultOrigins='http://localhost:5173,https://shilpnsoul-react-fe.vercel.app';

const app=express(),origins=(process.env.CORS_ORIGINS||defaultOrigins).split(',').map(value=>value.trim());

app.use(cors({origin:(origin,callback)=>!origin||origins.includes(origin)?callback(null,true):callback(new Error('CORS origin denied')),exposedHeaders:['X-Total-Count']}));app.use(express.json({limit:'64kb'}));

app.get('/api/health',async(req,res)=>{await sql`SELECT 1`;res.json({status:'ok',database:'connected'})});

app.use('/api',login);
app.use('/api/users',users);
app.use('/api',catalog);
app.use('/api',carts);
app.use('/api',orders);

app.use((req,res)=>res.status(404).json({error:'Endpoint not found.'}));
app.use((error,req,res,next)=>{if(res.headersSent)return next(error);console.error(error);
    if(error.code==='DATABASE_URL_MISSING')return res.status(503).json({error:'Database connection is not configured for this deployment.'});
    if(error.message==='CORS origin denied')return res.status(403).json({error:error.message});
    if(error.code==='23505')return res.status(409).json({error:'Duplicate value.'});
    if(error.code==='23503')return res.status(409).json({error:'Record is referenced.'});return res.status(500).json({error:'Internal server error.'})});
if(process.env.NODE_ENV!=='production'){const port=Number(process.env.PORT)||3000;app.listen(port,()=>console.log(`API listening on ${port}`))}export default app;
