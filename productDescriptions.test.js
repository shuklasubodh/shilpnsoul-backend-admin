import test from 'node:test';
import assert from 'node:assert/strict';
import {strToU8,zipSync} from 'fflate';
import {parseDocx} from './productDescriptions.js';

test('DOCX text extraction avoids the vulnerable mammoth parser chain',async()=>{
  const xml=`<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body>
    <w:p><w:r><w:t>1. Painted Tray</w:t></w:r></w:p>
    <w:p><w:r><w:t>Product Code</w:t></w:r></w:p><w:p><w:r><w:t>SP-1</w:t></w:r></w:p>
    <w:p><w:r><w:t>Dimensions</w:t></w:r></w:p><w:p><w:r><w:t>10 &amp; 12 cm</w:t></w:r></w:p>
    <w:p><w:r><w:t>Color</w:t></w:r></w:p><w:p><w:r><w:t>Blue</w:t></w:r></w:p>
    <w:p><w:r><w:t>Pattern / Craft</w:t></w:r></w:p><w:p><w:r><w:t>Hand painted</w:t></w:r></w:p>
    <w:p><w:r><w:t>Catalogue Description</w:t></w:r></w:p><w:p><w:r><w:t>Artisan tray</w:t></w:r></w:p>
  </w:body></w:document>`;
  const archive=zipSync({'word/document.xml':strToU8(xml)});
  const rows=await parseDocx(Buffer.from(archive));
  assert.deepEqual(rows,[{sku:'SP-1',title:'Painted Tray',dimensions:'10 & 12 cm',color_description:'Blue',pattern_craft:'Hand painted',catalogue_description:'Artisan tray',festive_note:''}]);
});
