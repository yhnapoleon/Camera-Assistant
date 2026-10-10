import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {deepseekResponse} from '../src/deepseek.js';
test('DeepSeek sends original image context, propagates cancellation and exposes only answer text',async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'ds-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const image=path.join(dir,'test.png');await sharp({create:{width:20,height:20,channels:3,background:'white'}}).png().toFile(image);
 const abort=new AbortController();let received;
 const args={apiKey:'test-secret',image,instructions:'规则',prompt:'题目',signal:abort.signal,request:async(url,options)=>{received=options;assert.equal(url,'https://api.deepseek.com/responses');const b=JSON.parse(options.body);assert.equal(b.model,'deepseek-flash');assert.match(b.input[0].content[1].image_url,/^data:image\/jpeg;base64,/);return {ok:true,json:async()=>({status:'completed',output:[{type:'reasoning',content:[{type:'reasoning_text',text:'hidden'}]},{type:'message',role:'assistant',content:[{type:'output_text',text:'答案'}]}]})};}};
 assert.equal(await deepseekResponse(args),'答案');abort.abort();assert.equal(received.signal.aborted,true);
 await assert.rejects(deepseekResponse({...args,signal:undefined,request:async()=>({ok:true,json:async()=>({status:'incomplete',output:[]})})}),/未完整/);
 await assert.rejects(deepseekResponse({...args,signal:undefined,request:async()=>({ok:false,status:401})}),/401/);
});
