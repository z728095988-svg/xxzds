import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {consumeUpdates, matchesPair, Telegram, TelegramError, deliverOne, isExpectedBot} from '../src/telegram.mjs';
import {notifications} from '../src/format.mjs';
import {samples} from '../src/source.mjs';
const NOW=Date.parse('2026-11-13T00:10:00Z');
const CODE='a'.repeat(32);
const message=(id=123,text='/start '+CODE)=>({chat:{id,type:'private'},from:{id,is_bot:false},text,date:Math.floor(NOW/1000)});
const memory={snapshots:{},health:{binance:'live',okx:'live'}};

test('only the requested bot username passes identity verification',()=>{
  assert.equal(isExpectedBot({id:123,is_bot:true,username:'rdhjvcxsbot'}),true);
  assert.equal(isExpectedBot({id:123,is_bot:true,username:'RDHJVCXSBOT'}),true);
  assert.equal(isExpectedBot({id:123,is_bot:true,username:'another_bot'}),false);
});
test('missing or invalid bot identity cannot start recipient binding',()=>{
  assert.equal(isExpectedBot(null),false);
  assert.equal(isExpectedBot({id:123,is_bot:false,username:'rdhjvcxsbot'}),false);
  assert.equal(isExpectedBot({id:123,is_bot:true}),false);
  assert.equal(isExpectedBot({id:-123,is_bot:true,username:'rdhjvcxsbot'}),false);
});

test('binding requires exact random code and a fresh private chat from its owner',()=>{
  assert.equal(matchesPair(message(),CODE,NOW),true);
  assert.equal(matchesPair(message(123,'/start '+'b'.repeat(32)),CODE,NOW),false);
  const group=message();group.chat.type='group';assert.equal(matchesPair(group,CODE,NOW),false);
  const forwarded=message();forwarded.from.id=456;assert.equal(matchesPair(forwarded,CODE,NOW),false);
  const stale=message();stale.date-=601;assert.equal(matchesPair(stale,CODE,NOW),false);
});
test('binding persists only one recipient and ignores replayed updates',()=>{
  const store=new Store(':memory:');
  consumeUpdates(store,[{update_id:1,message:message()},{update_id:2,message:message(456)}],CODE,NOW);
  assert.equal(store.get('chatId'),'123');assert.equal(store.pendingCount(),1);
  consumeUpdates(store,[{update_id:1,message:message()}],CODE,NOW);
  assert.equal(store.pendingCount(),1);assert.equal(store.get('telegramOffset'),3);store.close();
});
test('another chat cannot request status notifications',()=>{
  const store=new Store(':memory:');store.set('chatId','123');
  consumeUpdates(store,[{update_id:1,message:message(456,'/status')}],CODE,NOW);
  assert.equal(store.pendingCount(),0);
  consumeUpdates(store,[{update_id:2,message:message(123,'/status')}],CODE,NOW);
  assert.equal(store.pendingCount(),1);store.close();
});
test('snapshot and notification writes roll back together on storage failure',()=>{
  const store=new Store(':memory:');
  assert.throws(()=>store.saveCheck(memory,[{id:'bad',text:null}],NOW));
  assert.equal(store.get('memory'),null);assert.equal(store.pendingCount(),0);store.close();
});
test('committed pending notifications survive restart and deduplicate by ID',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aoying-test-'));const path=join(dir,'state.sqlite');
  let store=new Store(path);store.saveCheck(memory,[{id:'one',text:'仓位变化'}],NOW);store.close();
  store=new Store(path);store.saveCheck(memory,[{id:'one',text:'仓位变化'}],NOW);
  assert.equal(store.pendingCount(),1);assert.equal(store.get('lastCheckAt'),NOW);
  store.close();rmSync(dir,{recursive:true,force:true});
});
test('failed Telegram delivery retains item and respects server retry_after',async()=>{
  const store=new Store(':memory:');store.set('chatId','123');store.enqueue('one','变化',NOW);
  const failure={send:async()=>{throw new TelegramError(429,120);}};
  assert.equal((await deliverOne(store,failure,NOW)).status,'retry');
  assert.equal(store.nextMessage(NOW+119000),null);
  assert.equal(store.nextMessage(NOW+120000).attempts,1);
  let sent=0;const success={send:async(id,text)=>{assert.equal(id,'123');assert.equal(text,'变化');sent++;return 99;}};
  await deliverOne(store,success,NOW+120000);await deliverOne(store,success,NOW+121000);
  assert.equal(sent,1);assert.equal(store.pendingCount(),0);store.close();
});
test('no outbound message is sent before recipient binding',async()=>{
  const store=new Store(':memory:');store.enqueue('one','变化',NOW);
  const result=await deliverOne(store,{send:async()=>assert.fail('must not send')},NOW);
  assert.equal(result.status,'unpaired');store.close();
});
test('Telegram errors never contain token, URL, or raw upstream content',async()=>{
  const secret='123:secret_test_value';
  const telegram=new Telegram(secret,async()=>{throw Error('network error https://api.telegram.org/bot'+secret+'/sendMessage');});
  await assert.rejects(telegram.send('123','hello'),error=>!String(error).includes(secret)&&!String(error).includes('https:'));
});
test('successful Telegram API call uses JSON POST and disables link preview',async()=>{
  const telegram=new Telegram('123:fake',async(url,options)=>{
    assert.ok(url.endsWith('/sendMessage'));assert.equal(options.method,'POST');
    const body=JSON.parse(options.body);assert.equal(body.chat_id,'123');assert.equal(body.link_preview_options.is_disabled,true);
    assert.equal(body.parse_mode,undefined);
    return Response.json({ok:true,result:{message_id:42}});
  });
  assert.equal(await telegram.send('123','test'),42);
});
test('only one process can acquire the database lease until expiration',()=>{
  const store=new Store(':memory:');assert.equal(store.lease('a',NOW),true);
  assert.equal(store.lease('b',NOW+1),false);assert.equal(store.lease('a',NOW+15000),true);
  assert.equal(store.lease('b',NOW+106000),true);store.close();
});
test('many position changes are split into valid Telegram-sized notifications',()=>{
  const change={id:'x',source:'binance',symbol:'ETHUSDT',side:'LONG',type:'add',before:'1',after:'2',intervalStart:new Date(NOW-60000).toISOString(),intervalEnd:new Date(NOW).toISOString()};
  const result=notifications({changes:Array.from({length:100},(_,i)=>({...change,id:String(i)})),messages:[]},NOW);
  assert.ok(result.length>1);assert.ok(result.every(x=>x.text.length<=4096));
  assert.ok(result.every(x=>x.text.includes('不是逐笔成交')));
  assert.equal(notifications({changes:[],messages:[]},NOW).length,0);
});
test('bad or stale source responses never become empty valid positions',async()=>{
  const result=await samples({fetchImpl:async()=>Response.json({status:'ok'}),now:()=>NOW});
  assert.ok(result.binance.error);assert.ok(result.okx.error);
});
