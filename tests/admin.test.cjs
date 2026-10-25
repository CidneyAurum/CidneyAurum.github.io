const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {resolve}=require('node:path');
const admin=require('../js/admin.js');
const originalFetch=global.fetch;
const originalStorage=global.localStorage;
const file=(sha,value)=>({type:'file',sha,encoding:'base64',content:Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64')});
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{global.localStorage={getItem:()=> 'github_pat_fake_for_tests'};admin.ADMIN.maxPolls=1;admin.ADMIN.pollDelay=0;admin.ADMIN.requestTimeout=50;});
afterEach(()=>{global.fetch=originalFetch;global.localStorage=originalStorage;});

test('preview rejects executable URLs and escapes attributes, raw HTML and inline code',()=>{
  for(const raw of ['[click](javascript:alert(1))','![x](data:image/svg+xml,evil)','[click](&#106;avascript:evil)','[click](java\tscript:evil)'])assert.doesNotMatch(admin.mdToHtml(raw),/<(?:a|img)\b/);
  const html=admin.mdToHtml('![a" onerror="evil](https://example.com/x.png)\n<img src=x onerror=evil>\n`**raw** [x](javascript:evil)`');
  assert.match(html,/alt="a&quot; onerror=&quot;evil"/);
  assert.match(html,/&lt;img src=x onerror=evil&gt;/);
  assert.match(html,/<code>\*\*raw\*\* \[x\]\(javascript:evil\)<\/code>/);
});

test('preview matches build Markdown structure for fences, lists, nested text and links',()=>{
  const fixtures=[
    '# 标题\n1. one\n2) **two**\n- plain\n> 引用\n---',
    '~~~js\nconst x = "<tag>";\n~~~\n```text\n',
    '````python\n```\n<unsafe>\n````',
    '**bold *inside*** and `literal **`\n[笔记](hello-world.md)\n![图](assets/gallery/a.png)\n[mail](mailto:a@example.com)',
    '[x](javascript:alert(1)) ![evil](data:image/png,abc)\n![a"b](https://example.com/a_(b).jpg)',
  ];
  const py='import json,sys;sys.path.insert(0,"tools");import build;build.pygments_highlight=lambda *_:None;print(json.dumps([build.md_to_html(x) for x in json.load(sys.stdin)],ensure_ascii=False))';
  const expected=JSON.parse(execFileSync('python',['-c',py],{cwd:resolve(__dirname,'..'),input:JSON.stringify(fixtures),encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}}));
  const normalize=html=>html.replace(/\s(?:target|rel)="[^"]*"/g,'').replace(/(href|src)="([^"]*)"/g,(_,key,url)=>`${key}="${new URL(url,'https://cidneyaurum.github.io/posts/').href}"`);
  fixtures.forEach((md,i)=>assert.equal(normalize(admin.mdToHtml(md)),normalize(expected[i]),md));
});

test('post validation rejects invalid dates, empty content and unsafe/draft paths',()=>{
  const good={title:'你好',body:'正文',date:'2024-02-29',slug:'你好-note_2'};
  assert.equal(admin.validatePost(good),good);
  for(const date of ['2025-02-29','2026-02-30','0000-01-01','2026-2-1',''])assert.throws(()=>admin.validatePost({...good,date}),/日期/);
  for(const slug of ['../hello','_draft','a.md','a/b','a#b','a?b','x'.repeat(101),''])assert.throws(()=>admin.validatePost({...good,slug}),/文件名/);
  assert.throws(()=>admin.validatePost({...good,title:' '}),/标题/);
  assert.throws(()=>admin.validatePost({...good,body:'\n '}),/正文/);
});

test('exported metadata round-trips through actual build front matter without injection',()=>{
  const values={'p-title':'\'quoted "title"\'\nsecond line','p-date':'2026-10-25','p-slug':'safe-post','p-tags':'日常, 笔记','p-emoji':'🌙','p-summary':'摘要\n---\ndate: 2000-01-01','p-body':'正文'};
  global.document={getElementById:id=>({value:values[id]})};
  let md;
  try{md=admin.buildMarkdown();}finally{delete global.document;}
  const py='import json,sys;sys.path.insert(0,"tools");import build;print(json.dumps(build.parse_front_matter(sys.stdin.read()),ensure_ascii=False))';
  const [meta,body]=JSON.parse(execFileSync('python',['-c',py],{cwd:resolve(__dirname,'..'),input:md.text,encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}}));
  assert.equal(meta.title,values['p-title']);assert.equal(meta.summary,values['p-summary']);assert.equal(meta.date,'2026-10-25');assert.equal(body,'正文');
});

test('read failure never falls through to PUT; create-only collision preserves existing file',async()=>{
  let calls=[];
  global.fetch=async(url,opts)=>{calls.push(opts.method||'GET');return response({message:'unavailable'},500);};
  await assert.rejects(admin.ghPutFile('_posts/new.md',new Uint8Array([1]),'test',{createOnly:true}),/500/);
  assert.deepEqual(calls,['GET']);calls=[];
  global.fetch=async(url,opts)=>{calls.push(opts.method||'GET');return response(file('old','existing'));};
  await assert.rejects(admin.ghPutFile('_posts/new.md',new Uint8Array([1]),'test',{createOnly:true}),/同名/);
  assert.deepEqual(calls,['GET']);
});

test('new uploads specify main branch and UTF-8 base64 only after confirmed 404',async()=>{
  let payload;
  global.fetch=async(url,opts)=>{if(opts.method==='PUT'){payload=JSON.parse(opts.body);return response({commit:{sha:'new'}});}assert.match(url,/ref=main$/);return response({},404);};
  await admin.ghPutFile('_posts/中文.md',new TextEncoder().encode('你好'),'test',{createOnly:true});
  assert.equal(payload.branch,'main');assert.equal(Buffer.from(payload.content,'base64').toString(),'你好');assert.equal(payload.sha,undefined);
});

test('says conflict rereads and merges concurrent entry using its matching SHA',async()=>{
  let reads=0,puts=[];
  global.fetch=async(url,opts)=>{
    if(opts.method!=='PUT')return response(file(++reads===1?'first':'second',{says:[{id:reads===1?'old':'concurrent',text:'keep'}],extra:1}));
    const payload=JSON.parse(opts.body);puts.push(payload);
    return puts.length===1?response({message:'conflict'},409):response({commit:{sha:'merged'}});
  };
  await admin.mergeSay({id:'mine',text:'new',images:[],time:'2026-10-25 12:00'});
  assert.equal(reads,2);assert.equal(puts[1].sha,'second');
  const result=JSON.parse(Buffer.from(puts[1].content,'base64').toString());
  assert.deepEqual(result.says.map(s=>s.id),['mine','concurrent']);assert.equal(result.extra,1);
});

test('malformed says JSON stops before write',async()=>{
  let puts=0;
  global.fetch=async(url,opts)=>{if(opts.method==='PUT')puts++;return response(file('sha','broken JSON'));};
  await assert.rejects(admin.mergeSay({id:'mine',text:'new'}),/停止写入/);assert.equal(puts,0);
});

test('timeouts surface uncertainty without retrying writes',async()=>{
  admin.ADMIN.requestTimeout=5;
  let calls=0;
  global.fetch=async(url,opts)=>{calls++;return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('aborted'))));};
  await assert.rejects(admin.apiRequest('/test',{method:'PUT',body:'{}'}),/超时.*检查仓库/);assert.equal(calls,1);
});

test('online requires successful github-pages deployment for exact SHA',async()=>{
  global.fetch=async url=>url.includes('/deployments?')?response([]):response({workflow_runs:[{head_sha:'sha',path:'.github/workflows/build.yml',event:'push',status:'completed',conclusion:'success'}]});
  assert.equal((await admin.trackBuild('sha')).ok,false);
  global.fetch=async url=>url.includes('/deployments?')?response([{id:2,sha:'sha',environment:'github-pages'}]):response([{state:'success'}]);
  assert.equal((await admin.trackBuild('sha')).ok,true);
  global.fetch=async url=>url.includes('/deployments?')?response([{id:2,sha:'other',environment:'github-pages'}]):response({workflow_runs:[]});
  assert.equal((await admin.trackBuild('sha')).ok,false);
});

test('gallery names preserve date suffix and avoid same-title collisions',()=>{
  const a=admin.galleryFilename('same name','.png'),b=admin.galleryFilename('same name','.png');
  assert.notEqual(a,b);assert.match(a,/^samename__upload-[a-f\d]{10}_\d{4}-\d{2}\.png$/i);
});
