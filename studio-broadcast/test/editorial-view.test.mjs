import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEditorialTitles, presenterFromCurrentPosition,conversationFocus,chartCameraOffset } from '../public/editorial-view.mjs';
test('chart framing reserves a responsive gutter without moving the avatar',()=>{
 assert.ok(Math.abs(chartCameraOffset(1280)-256)<.01);assert.ok(Math.abs(chartCameraOffset(1920)-384)<.01);assert.equal(chartCameraOffset(NaN),0);
 const center=.5-chartCameraOffset(1280)/1280;assert.ok(center+.20<.54);assert.ok(center-.20>0);
});
test('whole-response focus and title survive a silent segment gap, not final completion or stale state',()=>{
 const now=Date.now(),response={id:'response',kind:'chat',title:'The viewer question',expiresAt:now+60000};
 const program={editorial:{now,pendingChat:0,activeResponse:response},titleOwner:'editorial',titles:{ticker:[]}};
 const gap={connected:true,phase:'idle',editorial:null};
 assert.equal(conversationFocus(program,gap,now),true);assert.equal(composeEditorialTitles(program,gap).title,response.title);
 assert.equal(conversationFocus({...program,editorial:{now,pendingChat:0,activeResponse:null}},gap,now),false);
 assert.equal(conversationFocus(program,gap,now+60001),false);assert.equal(conversationFocus(program,gap,now+6000),false);
 assert.equal(composeEditorialTitles({...program,titleOwner:'operator',titles:{title:'Manual override'}},gap).title,'Manual override');
});
test('local title follows audible owned job, not a delayed program poll; ticker continues',()=>{
  const program={editorial:{pendingChat:1},titleOwner:'editorial',titles:{enabled:true,title:'Old filler',ticker:['Fresh news']}};
  const playing={connected:true,phase:'playing',editorial:{kind:'chat',title:'Question from chat'}};
  assert.equal(composeEditorialTitles(program,playing).title,'Question from chat');
  assert.deepEqual(composeEditorialTitles(program,playing).ticker,['Fresh news']);
  assert.equal(composeEditorialTitles(program,{...playing,phase:'idle'}).title,'');
  assert.equal(composeEditorialTitles({...program,titleOwner:'operator'},playing).title,'Old filler');
  assert.equal(composeEditorialTitles(program,{connected:false}).title,'Old filler');
});
test('chat camera frames the avatar where she stands, without changing root position or baseline',()=>{
  const position={x:4,z:-2};const before={...position};
  for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2]){
    const view=presenterFromCurrentPosition(position,yaw);assert.equal(view.target[0],position.x);assert.equal(view.target[2],position.z);
    assert.ok(Math.abs(Math.hypot(view.position[0]-position.x,view.position[2]-position.z)-2.12)<1e-8);
  }
  assert.deepEqual(position,before);assert.equal(presenterFromCurrentPosition(position,NaN),null);
});
