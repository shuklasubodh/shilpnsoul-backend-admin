import {Router} from 'express';
import path from 'node:path';
import multer from 'multer';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import sql from './db.js';
import {authenticate,admin} from './auth.js';

const router=Router();
const upload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:10*1024*1024,files:1},
  fileFilter(req,file,done){
    const extension=path.extname(file.originalname).toLowerCase();
    done(extension==='.docx'||extension==='.xlsx'?null:new Error('Only .docx and .xlsx files are supported.'),extension==='.docx'||extension==='.xlsx');
  },
});

const normalizedHeader=value=>String(value||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
const aliases={
  sku:['product_code','productcode','code','sku'],title:['title','product_name','name'],dimensions:['dimensions','dimension','size'],
  color_description:['color_description','colour_description','color','colour'],pattern_craft:['pattern_craft','pattern','craft','pattern_or_craft'],
  catalogue_description:['catalogue_description','catalog_description','description'],festive_note:['festive_note','why_customers_may_love_it_this_festive_season','festive_description','customer_note'],
};
const valueFor=(record,key)=>{for(const alias of aliases[key])if(record[alias]!==undefined&&record[alias]!==null)return String(record[alias]).trim();return''};
const normalizeRecord=record=>Object.fromEntries(['sku','title','dimensions','color_description','pattern_craft','catalogue_description','festive_note'].map(key=>[key,valueFor(record,key)]));

export const parseXlsx=async buffer=>{
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet=workbook.worksheets[0];
  if(!sheet)throw new Error('The workbook does not contain a worksheet.');
  const headers=sheet.getRow(1).values.slice(1).map(normalizedHeader),records=[];
  sheet.eachRow((row,rowNumber)=>{
    if(rowNumber===1)return;
    const record={};
    headers.forEach((header,index)=>{const cell=row.getCell(index+1);record[header]=cell.text||cell.value||''});
    const normalized=normalizeRecord(record);
    if(Object.values(normalized).some(Boolean))records.push(normalized);
  });
  return records;
};

export const parseDocx=async buffer=>{
  const {value}=await mammoth.extractRawText({buffer});
  const lines=value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),records=[];
  const labels=['Product Code','Dimensions','Color','Pattern / Craft','Catalogue Description'];
  const positions=[];
  lines.forEach((line,index)=>{if(line==='Product Code')positions.push(index)});
  for(let block=0;block<positions.length;block++){
    const codeIndex=positions[block],end=positions[block+1]??lines.length,start=Math.max(0,codeIndex-1);
    const section=lines.slice(start,end),get=label=>{const index=section.indexOf(label);if(index<0)return'';return section[index+1]||''};
    const noteLine=section.find(line=>/^Why customers may love it this festive season:/i.test(line))||'';
    records.push({sku:get('Product Code'),title:section[0].replace(/^\d+\.\s*/,''),dimensions:get('Dimensions'),color_description:get('Color'),pattern_craft:get('Pattern / Craft'),catalogue_description:get('Catalogue Description'),festive_note:noteLine.replace(/^Why customers may love it this festive season:\s*/i,'')});
  }
  return records;
};

const validate=rows=>{
  const counts=new Map();
  for(const row of rows)if(row.sku)counts.set(row.sku.toLowerCase(),(counts.get(row.sku.toLowerCase())||0)+1);
  return rows.map((row,index)=>({...row,row_number:index+2,errors:[...(!row.sku?['Product Code is required.']:[]),...(!row.title?['Title is required.']:[]),...(row.sku&&counts.get(row.sku.toLowerCase())>1?['Product Code is duplicated in this document.']:[])]}));
};

router.use(authenticate,admin);

router.get('/product-descriptions/import-format',(req,res)=>res.json({
  accepted_files:['.docx','.xlsx'],max_file_size_mb:10,file_field:'document',
  required_columns:['Product Code','Title'],
  optional_columns:['Dimensions','Color Description','Pattern / Craft','Catalogue Description','Festive Note'],
  workflow:['POST with commit=false to preview','Correct invalid or unmatched rows','POST the same document with commit=true to save'],
}));

router.post('/product-descriptions/import',upload.single('document'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Upload a Word (.docx) or Excel (.xlsx) document in the document field.'});
  const extension=path.extname(req.file.originalname).toLowerCase();
  let parsed;
  try{parsed=extension==='.docx'?await parseDocx(req.file.buffer):await parseXlsx(req.file.buffer)}catch(error){return res.status(400).json({error:`The document could not be read: ${error.message}`})}
  const rows=validate(parsed),skus=[...new Set(rows.filter(row=>row.sku).map(row=>row.sku.toLowerCase()))];
  const products=skus.length?await sql.query('SELECT id,sku,name FROM products WHERE LOWER(sku)=ANY($1)',[skus]):[];
  const bySku=new Map(products.map(product=>[String(product.sku).toLowerCase(),product]));
  const preview=rows.map(row=>({...row,product:bySku.get(row.sku.toLowerCase())||null,status:row.errors.length?'INVALID':bySku.has(row.sku.toLowerCase())?'MATCHED':'UNMATCHED'}));
  const valid=preview.filter(row=>row.status==='MATCHED');
  if(String(req.query.commit).toLowerCase()!=='true')return res.json({commit:false,summary:{total:preview.length,matched:valid.length,unmatched:preview.filter(row=>row.status==='UNMATCHED').length,invalid:preview.filter(row=>row.status==='INVALID').length},rows:preview});
  if(preview.some(row=>row.status!=='MATCHED'))return res.status(422).json({error:'Resolve every invalid or unmatched product code before committing.',rows:preview});
  const payload=JSON.stringify(valid.map(({product,row_number,status,errors,...row})=>row));
  const saved=await sql.query(`WITH source AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(sku text,title text,dimensions text,color_description text,pattern_craft text,catalogue_description text,festive_note text)) INSERT INTO product_description(product_id,title,dimensions,color_description,pattern_craft,catalogue_description,festive_note) SELECT p.id,s.title,NULLIF(s.dimensions,''),NULLIF(s.color_description,''),NULLIF(s.pattern_craft,''),NULLIF(s.catalogue_description,''),NULLIF(s.festive_note,'') FROM source s JOIN products p ON LOWER(p.sku)=LOWER(s.sku) ON CONFLICT(product_id) DO UPDATE SET title=EXCLUDED.title,dimensions=EXCLUDED.dimensions,color_description=EXCLUDED.color_description,pattern_craft=EXCLUDED.pattern_craft,catalogue_description=EXCLUDED.catalogue_description,festive_note=EXCLUDED.festive_note,updated_at=NOW() RETURNING product_id`,[payload]);
  return res.json({commit:true,message:'Product descriptions imported successfully.',updated:saved.length});
});

export default router;
