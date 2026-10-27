import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorAuth, bearerMatches } from '../src/live-auth.mjs';

const TOKEN = 'operator-test-token-that-is-at-least-32-characters';
const req = (headers = {}, remoteAddress = '127.0.0.1') => ({headers:{host:'127.0.0.1:5890',origin:'http://127.0.0.1:5890','sec-fetch-site':'same-origin',...headers},socket:{remoteAddress}});
const response = () => ({headers:{},setHeader(name,value){this.headers[name.toLowerCase()] = value;}});
const errorCode = (code,status) => error => error.code === code && error.statusCode === status;
function login(auth, request = req(), input = {local:true}) { const res = response(); const result = auth.login(request,res,input); return {result,cookie:res.headers['set-cookie'].split(';')[0],header:res.headers['set-cookie']}; }

test('local login issues an HttpOnly same-site session; remote requests cannot use the local shortcut', () => {
  const auth = createOperatorAuth({operatorToken:TOKEN});
  const signed = login(auth); assert.equal(signed.result.authenticated,true); assert.equal(signed.result.local,true);
  assert.match(signed.header,/HttpOnly/); assert.match(signed.header,/SameSite=Lax/); assert.match(signed.header,/Max-Age=43200/);
  assert(auth.requireOperator(req({cookie:signed.cookie}),{mutation:true}));
  assert.throws(()=>login(auth,req({},'203.0.113.10'),{local:true}),errorCode('OPERATOR_UNAUTHORIZED',401));
  assert.throws(()=>login(createOperatorAuth({operatorToken:TOKEN,localOperator:false})),errorCode('OPERATOR_UNAUTHORIZED',401));
});

test('browser mutations reject cross-origin, absent-origin and DNS-rebinding requests even with a session', () => {
  const auth = createOperatorAuth({operatorToken:TOKEN}), {cookie} = login(auth);
  for (const headers of [{origin:'https://attacker.example'},{origin:'null'},{origin:undefined},{'sec-fetch-site':'cross-site'},
    {host:'attacker.example',origin:'http://attacker.example'}]) {
    assert.throws(()=>auth.requireOperator(req({...headers,cookie}),{mutation:true}),errorCode('ORIGIN_NOT_ALLOWED',403));
  }
  assert.throws(()=>login(auth,req({host:'127.0.0.1.evil.example',origin:'http://127.0.0.1.evil.example'})),errorCode('ORIGIN_NOT_ALLOWED',403));
  assert(auth.requireOperator(req({origin:undefined,cookie}),{mutation:false}), 'Read operations are still protected by the session');
});

test('operator bearer tokens work for server clients without an Origin and reject browser cross-origin use', () => {
  const auth = createOperatorAuth({operatorToken:TOKEN}), authorization = 'Bearer '+TOKEN;
  assert(bearerMatches(req({authorization}),TOKEN));
  for (const value of ['Bearer '+TOKEN+'\n','Bearer  '+TOKEN,'Bearer wrong','bearer '+TOKEN,'Basic '+TOKEN]) assert.equal(bearerMatches(req({authorization:value}),TOKEN),false);
  assert(auth.requireOperator(req({authorization,origin:undefined,'sec-fetch-site':undefined}),{mutation:true}));
  assert.throws(()=>auth.requireOperator(req({authorization,origin:'https://evil.example'}),{mutation:true}),errorCode('ORIGIN_NOT_ALLOWED',403));
  assert.throws(()=>auth.requireOperator(req({origin:undefined}),{mutation:false}),errorCode('OPERATOR_UNAUTHORIZED',401));
});

test('public HTTPS origin requires a real operator credential and marks the cookie Secure', () => {
  const auth = createOperatorAuth({operatorToken:TOKEN,publicOrigin:'https://studio.example',localOperator:false});
  const request = req({host:'studio.example',origin:'https://studio.example'},'203.0.113.10');
  const signed = login(auth,request,{token:TOKEN}); assert.match(signed.header,/; Secure/);
  assert.equal(auth.origin(request),'https://studio.example');
  assert.throws(()=>login(auth,request,{token:'incorrect'}),errorCode('OPERATOR_UNAUTHORIZED',401));
});

test('sessions expire, logout invalidates the exact cookie, and forged IDs never authenticate', () => {
  let now = 1_000_000; const auth = createOperatorAuth({operatorToken:TOKEN},{now:()=>now});
  const first = login(auth), second = login(auth); assert.notEqual(first.cookie,second.cookie);
  const res = response(); auth.logout(req({cookie:first.cookie}),res);
  assert.equal(auth.session(req({cookie:first.cookie})),null); assert(auth.session(req({cookie:second.cookie})));
  assert.match(res.headers['set-cookie'],/Max-Age=0/);
  assert.equal(auth.session(req({cookie:'air3_operator=forged'})),null);
  now += 12*3600_000+1; assert.equal(auth.session(req({cookie:second.cookie})),null);
});

test('login throttling limits failed remote credentials and resets after its time window', () => {
  let now = 100_000; const auth = createOperatorAuth({operatorToken:TOKEN,localOperator:false},{now:()=>now});
  const request = req({},'203.0.113.12');
  for (let n=0;n<10;n++) assert.throws(()=>login(auth,request,{token:'wrong'}),errorCode('OPERATOR_UNAUTHORIZED',401));
  assert.throws(()=>login(auth,request,{token:TOKEN}),errorCode('LOGIN_RATE_LIMIT',429));
  now += 60_001; assert.equal(login(auth,request,{token:TOKEN}).result.authenticated,true);
});

test('malformed login helpers fail as structured client errors and do not invent a session', () => {
  const auth = createOperatorAuth({operatorToken:TOKEN});
  for (const input of [null,[],{local:'true'},{local:true,role:'administrator'},JSON.parse('{"__proto__":{"local":true}}')]) {
    assert.throws(()=>login(auth,req(),input),error => Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500);
  }
});
