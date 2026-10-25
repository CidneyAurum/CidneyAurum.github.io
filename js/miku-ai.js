/* Contextual Miku AI: the browser talks only to the site's gateway, never a model key. */
(() => {
  "use strict";
  if (window.MikuAI) return;
  const source = new URL(document.currentScript.src);
  const root = new URL("../", source);
  const localPreview = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const modes = new Set(["chat", "article", "discover", "write"]);
  const MAX_SELECTION = 8000;
  const MAX_HISTORY_ITEM = 4000, MAX_HISTORY_TOTAL = 16000, MAX_REQUEST_BYTES = 32768;
  const emotions = new Set(["比心", "圈圈", "脸红", "前倾", "唱歌", "葱", "QQ人"]);
  const emotionMap = {neutral:null,happy:"比心",thinking:"前倾",shy:"脸红",sad:"前倾",singing:"唱歌"};
  let service = {configured:false,model:"",features:[],endpoint:"",error:"正在连接 AI 服务…",checking:true};
  let configPromise, refreshPromise;
  const make = (tag, cls, text) => { const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=String(text);return el; };
  const button = (text, cls="") => { const el=make("button",cls,text);el.type="button";return el; };
  const styleURL = new URL("css/miku-ai.css",root);
  if (source.search) styleURL.search=source.search;
  if (![...document.querySelectorAll('link[rel="stylesheet"]')].some(link=>new URL(link.href).pathname===styleURL.pathname)) {
    const link=make("link");link.rel="stylesheet";link.href=styleURL.href;document.head.appendChild(link);
  }
  function gatewayBase(value) {
    if (!value) return "";
    const url=new URL(value,root);
    if (url.username||url.password||url.search||url.hash) throw new Error("AI 服务地址配置不正确");
    const loopback=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    if (url.protocol!=="https:" && !(url.protocol==="http:"&&localPreview&&loopback)) throw new Error("AI 服务需要安全连接");
    return url.href.replace(/\/+$/,"");
  }
  async function requestJSON(url, {signal,timeout=45000,...options}={}) {
    const controller=new AbortController();let timedOut=false;
    const abort=()=>controller.abort(signal?.reason);
    if(signal?.aborted)abort();else signal?.addEventListener("abort",abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
    try {
      const response=await fetch(url,{...options,signal:controller.signal,credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer",headers:options.body?{"Content-Type":"application/json"}:undefined});
      const raw=await response.text();let data;
      try{data=JSON.parse(raw);}catch(_){throw new Error("AI 服务没有返回有效内容，请稍后重试");}
      if(!response.ok){const message=typeof data.error==="string"?data.error:data.error?.message||data.message;throw new Error(message||`AI 服务暂时不可用（${response.status}）`);}
      return data;
    } catch(error) {
      if(controller.signal.aborted){if(timedOut)throw new Error("Miku 等待回复超时了，可以稍后重试");const canceled=new Error("已取消这次请求");canceled.name="AbortError";throw canceled;}
      if(error instanceof TypeError)throw new Error("暂时连接不上 AI 服务，请稍后重试");
      throw error;
    } finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
  }
  function apiPath(path){return service.endpoint.replace(/\/api$/i,"")+"/api/"+path;}
  function notifyStatus(){document.dispatchEvent(new CustomEvent("miku:ai-status",{detail:status()}));updateAvailability();}
  function status(){return {...service,features:Array.isArray(service.features)?[...service.features]:{...service.features}};}
  async function readConfig(){
    if(!configPromise)configPromise=(async()=>{
      let configured="";
      try{const config=await requestJSON(new URL("data/ai-config.json",root),{timeout:5000});configured=typeof config.endpoint==="string"?config.endpoint:"";}catch(_){configPromise=null;}
      return gatewayBase(configured||(localPreview?"http://127.0.0.1:8787":""));
    })();
    return configPromise;
  }
  function refresh(){
    if(refreshPromise)return refreshPromise;
    // A visitor's explicit reconnect also re-reads the public endpoint config.
    // The in-flight refresh promise coalesces concurrent status/config checks.
    configPromise=null;
    service.checking=true;notifyStatus();
    refreshPromise=(async()=>{
      try {
        service.endpoint=await readConfig();
        if(!service.endpoint){service={...service,configured:false,checking:false,error:"AI 服务尚未配置；文章和音乐仍可正常浏览。"};return status();}
        const value=await requestJSON(apiPath("status"),{timeout:6000});
        if(typeof value.configured!=="boolean")throw new Error("AI 服务状态暂时无法确认");
        service={...service,configured:value.configured,model:typeof value.model==="string"?value.model:"",features:value.features||[],checking:false,error:value.configured?"":"AI 服务尚未配置完成，请稍后再来。"};
      }catch(error){service={...service,configured:false,checking:false,error:error.message||"AI 服务暂时未连接"};}
      finally{refreshPromise=null;notifyStatus();}
      return status();
    })();
    return refreshPromise;
  }
  function safeLocalURL(raw){
    if(typeof raw!=="string"||!raw||/[\\\x00-\x20]/.test(raw))return null;
    try{
      const url=new URL(raw,root);
      if(url.origin!==root.origin||url.username||url.password||!url.pathname.startsWith(root.pathname)||/%(?:2f|5c)/i.test(url.pathname))return null;
      const path=url.pathname.slice(root.pathname.length);
      if(path!==""&&!/^(?:(?:index|blog|says|photos|about)\.html|posts\/[^/]+\.html)$/.test(path))return null;
      return url.href;
    }catch(_){return null;}
  }
  function normalizeResult(value){
    if(!value||typeof value.reply!=="string"||!value.reply.trim())throw new Error("Miku 没有收到完整回复，请重试");
    return {
      reply:value.reply.slice(0,30000),emotion:emotions.has(value.emotion)?value.emotion:Object.hasOwn(emotionMap,value.emotion)?emotionMap[value.emotion]:null,
      citations:(Array.isArray(value.citations)?value.citations:[]).slice(0,8).flatMap(citation=>{
        const url=safeLocalURL(citation?.url);return url?[{id:String(citation.id||""),title:String(citation.title||"相关手记").slice(0,160),url,excerpt:String(citation.excerpt||"").slice(0,600)}]:[];
      }),
      actions:(Array.isArray(value.actions)?value.actions:[]).slice(0,4).flatMap(action=>{
        if(!action||!["navigate","listen","heart"].includes(action.type))return [];
        const target=action.type==="navigate"?safeLocalURL(action.target):["string","number"].includes(typeof action.target)?String(action.target).slice(0,160):"";
        return action.type==="navigate"&&!target?[]:[{type:action.type,target,label:String(action.label||({navigate:"打开手记",listen:"一起听歌",heart:"给你比心"}[action.type])).slice(0,60)}];
      }),
      ...(value.usage&&typeof value.usage==="object"?{usage:value.usage}:{}),
    };
  }
  function currentContext(selection=""){
    const context={page:document.body.dataset.page||"home"};
    const match=location.pathname.match(/\/posts\/([^/]+)\.html$/);
    if(match){try{context.slug=decodeURIComponent(match[1]);}catch(_){context.slug=match[1];}}
    if(selection)context.selection=selection;
    return context;
  }
  async function ask({message,history=[],mode="chat",context=currentContext(),task,signal}={}){
    const text=String(message||"").trim();
    if(!text)throw new Error("先写下想问的问题吧");
    if(text.length>4000)throw new Error("问题有些长，请缩短到 4000 字以内");
    if(!modes.has(mode))throw new Error("这项对话模式暂时不可用");
    if(signal?.aborted){const error=new Error("已取消这次请求");error.name="AbortError";throw error;}
    await ready;
    if(!service.configured)throw new Error(service.error||"AI 服务尚未连接");
    const clean={page:typeof context?.page==="string"?context.page.slice(0,40):"home"};
    if(typeof context?.slug==="string"){
      if(context.slug.length>160)throw new Error("文章路径过长，暂时无法确认文章上下文；本次未发送。");
      clean.slug=context.slug;
    }
    if(typeof context?.selection==="string"){
      if(context.selection.length>MAX_SELECTION)throw new Error("选段较长，请缩短到 8000 字以内；本次未发送。");
      clean.selection=context.selection;
    }
    const turns=(Array.isArray(history)?history:[]).filter(turn=>["user","assistant"].includes(turn?.role)&&typeof turn.content==="string"&&turn.content.trim()).slice(-12).map(turn=>{
      let content=turn.content.slice(0,MAX_HISTORY_ITEM);
      if(/[\uD800-\uDBFF]$/.test(content))content=content.slice(0,-1);
      return {role:turn.role,content};
    }).filter(turn=>turn.content.trim()&&!turn.content.includes("\u0000"));
    let historySize=turns.reduce((sum,turn)=>sum+turn.content.length,0);
    while(historySize>MAX_HISTORY_TOTAL&&turns.length)historySize-=turns.shift().content.length;
    const payload={message:text,history:turns,mode,context:clean};
    if(task!==undefined){if(!["title","summary","polish"].includes(task))throw new Error("这项写作任务暂时不可用");payload.task=task;}
    const encoder=new TextEncoder();let serialized=JSON.stringify(payload);
    while(encoder.encode(serialized).byteLength>MAX_REQUEST_BYTES&&turns.length){turns.shift();serialized=JSON.stringify(payload);}
    if(encoder.encode(serialized).byteLength>MAX_REQUEST_BYTES)throw new Error("问题与选段合计内容较长，请缩短问题或选段后再发送；本次未发送，也没有截断内容。");
    return normalizeResult(await requestJSON(apiPath("chat"),{method:"POST",body:serialized,signal}));
  }

  let dialog=null, conversation=null, currentController=null, lastFocus=null, dialogSequence=0, activeRow=null, activeQuestion="";
  function settleCanceledRow(){
    if(!activeRow)return;
    const row=activeRow,message=activeQuestion;
    row.removeAttribute("aria-busy");row.replaceChildren(make("p","mai-error","已取消这次生成，原来的问题仍然保留。"));
    const retry=button("再试一次","mai-chip mai-retry");retry.addEventListener("click",()=>runDialogue(message,row));row.appendChild(retry);activeRow=null;
  }
  function close(){
    settleCanceledRow();
    currentController?.abort();currentController=null;dialogSequence++;
    if(dialog?.open)dialog.close();
    if(lastFocus?.isConnected)lastFocus.focus({preventScroll:true});
  }
  async function performAction(action,feedback){
    const unavailable=message=>{if(feedback){feedback.textContent=message;feedback.hidden=false;}window.MikuCompanion?.say(message);};
    try{
      if(action.type==="heart"){
        close();
        if(window.MikuHost)await window.MikuHost.intent("heart");else{window.MikuCompanion?.show();window.MikuCompanion?.react("比心");}
      }else if(action.type==="listen"){
        const target=String(action.target||"").trim(),music=window.MikuMusic;
        if(target){
          if(!music?.getQueue||!music?.playIndex){unavailable("歌单暂时没有准备好，未播放其他歌曲。请稍后再试。");return;}
          let queue=music.getQueue();
          if(!queue.length){await music.loadPlaylist?.();queue=music.getQueue();}
          const index=queue.findIndex(song=>String(song.id)===target);
          if(index<0){unavailable("这首歌暂时不在当前歌单里，未播放其他歌曲。");return;}
          if(await music.playIndex(index)===false){unavailable("这首歌暂时没能播放，未切换到其他歌曲。");return;}
        }
        close();
        if(window.MikuHost)await window.MikuHost.intent("listen");else if(!window.MikuMusic?.getState?.().playing)await window.MikuMusic?.toggle?.();
      }
    }catch(_){unavailable("这次没能打开，未切换到其他歌曲。请稍后再试。");}
  }
  function renderMessage(container,result){
    if(!(container instanceof Element)){result=container;container=null;}
    const value=normalizeResult(result),answer=make("div","mai-answer");
    answer.appendChild(make("div","mai-answer-text",value.reply));
    if(value.citations.length){
      const sources=make("div","mai-sources");sources.appendChild(make("span","mai-source-label","这次参考了"));
      value.citations.forEach(citation=>{const a=make("a","mai-source",citation.title);a.href=citation.url;if(citation.excerpt)a.appendChild(make("small","",citation.excerpt));a.addEventListener("click",close);sources.appendChild(a);});answer.appendChild(sources);
    }
    if(value.actions.length){const actions=make("div","mai-actions"),feedback=make("p","mai-action-status mai-error");feedback.hidden=true;feedback.setAttribute("role","status");value.actions.forEach(action=>{let el;if(action.type==="navigate"){el=make("a","mai-chip",action.label);el.href=action.target;el.addEventListener("click",close);}else{el=button(action.label,"mai-chip");el.addEventListener("click",async()=>{if(el.disabled)return;el.disabled=true;try{await performAction(action,feedback);}finally{el.disabled=false;}});}actions.appendChild(el);});answer.append(actions,feedback);}
    container?.appendChild(answer);return answer;
  }
  function updateAvailability(){
    if(!dialog)return;
    const hint=dialog.querySelector(".mai-service");
    hint.textContent=service.checking?"正在连接 Miku 的思考频道…":service.configured?"AI 已连接 · 基于本站内容回答，引用会显示在回复下方。":service.error;
    hint.classList.toggle("is-offline",!service.configured);
    dialog.querySelector(".mai-submit").disabled=!service.configured||!!currentController;
  }
  function ensureDialog(){
    if(dialog)return;
    dialog=make("dialog","mai-dialog");dialog.id="miku-ai-dialog";dialog.setAttribute("aria-labelledby","miku-ai-title");
    const head=make("header","mai-head"),mark=make("span","mai-mark","✦"),title=make("div","mai-head-copy");
    title.append(make("small","","MIKU · 一起想一想"),Object.assign(make("h2","","和 Miku 聊聊"),{id:"miku-ai-title"}));
    const exit=button("×","mai-close");exit.setAttribute("aria-label","关闭 Miku 对话");exit.addEventListener("click",close);head.append(mark,title,exit);
    const info=make("div","mai-info"),hint=make("p","mai-service");hint.setAttribute("role","status");
    const reconnect=button("重新连接","mai-reconnect");reconnect.addEventListener("click",()=>refresh());info.append(hint,reconnect);
    const selection=make("blockquote","mai-selection");selection.hidden=true;
    const messages=make("div","mai-messages");messages.setAttribute("role","log");messages.setAttribute("aria-live","polite");
    const form=make("form","mai-form"),input=make("textarea","mai-input");input.id="miku-ai-input";input.rows=3;input.maxLength=4000;input.placeholder="想问什么？慢慢说，我在听。";input.setAttribute("aria-label","给 Miku 的问题");
    const tools=make("div","mai-form-tools"),note=make("small","","Enter 发送 · Shift + Enter 换行"),cancel=button("取消生成","mai-cancel");cancel.hidden=true;cancel.addEventListener("click",()=>currentController?.abort());
    const submit=make("button","mai-submit","发送 ↗");submit.type="submit";tools.append(note,cancel,submit);form.append(input,tools);
    form.addEventListener("submit",event=>{event.preventDefault();const message=input.value.trim();if(message&&!currentController){input.value="";runDialogue(message);}});
    input.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();form.requestSubmit();}});
    dialog.addEventListener("cancel",event=>{event.preventDefault();close();});dialog.addEventListener("click",event=>{if(event.target===dialog)close();});
    dialog.append(head,info,selection,messages,form);document.body.appendChild(dialog);updateAvailability();
  }
  async function runDialogue(message,retryRow=null){
    if(currentController||!conversation)return;
    const active=conversation,history=[...active.history],sequence=++dialogSequence;
    const controller=currentController=new AbortController();updateAvailability();dialog.querySelector(".mai-cancel").hidden=false;
    const box=dialog.querySelector(".mai-messages");
    if(!retryRow)box.appendChild(make("div","mai-user",message));
    const row=retryRow||make("div","mai-assistant");row.replaceChildren(make("p","mai-pending","Miku 正在整理思路…"));row.setAttribute("aria-busy","true");if(!retryRow)box.appendChild(row);box.scrollTop=box.scrollHeight;
    activeRow=row;activeQuestion=message;
    try{
      const result=await ask({message,history,mode:active.mode,context:active.context,signal:controller.signal});
      if(sequence!==dialogSequence||active!==conversation||controller.signal.aborted)return;
      row.replaceChildren();renderMessage(row,result);active.history.push({role:"user",content:message},{role:"assistant",content:result.reply});
      if(result.emotion)window.MikuCompanion?.react(result.emotion);
    }catch(error){
      if(sequence!==dialogSequence||active!==conversation)return;
      row.replaceChildren(make("p","mai-error",error.name==="AbortError"?"这次先停在这里。想继续时，可以再问我。":error.message));
      const retry=button("再试一次","mai-chip mai-retry");retry.addEventListener("click",()=>runDialogue(message,row));row.appendChild(retry);
    }finally{
      row.removeAttribute("aria-busy");
      if(currentController===controller){currentController=null;activeRow=null;dialog.querySelector(".mai-cancel").hidden=true;updateAvailability();}
      box.scrollTop=box.scrollHeight;
    }
  }
  function open({mode="chat",question="",selection=""}={}){
    ensureDialog();settleCanceledRow();currentController?.abort();currentController=null;dialogSequence++;
    mode=modes.has(mode)?mode:"chat";
    const context=currentContext(selection),key=mode+"|"+(context.slug||"")+"|"+selection;
    if(conversation?.key!==key){conversation={key,mode,context,history:[]};dialog.querySelector(".mai-messages").replaceChildren(make("p","mai-welcome",mode==="article"?"我会结合这篇手记回答。也可以选中一段，让我们一起拆开看看。":mode==="discover"?"告诉我想找什么，我会从小窝里已有的内容中找线索。":"关于这个小窝、文章或你的想法，都可以和我聊。"));}
    dialog.querySelector("#miku-ai-title").textContent=mode==="article"?"和 Miku 聊这篇":mode==="discover"?"和 Miku 找找看":"和 Miku 聊聊";
    const quote=dialog.querySelector(".mai-selection");quote.hidden=!selection;quote.textContent=selection?"这次讨论的选段：\n"+selection.slice(0,800)+(selection.length>800?"\n…（此处仅预览前 800 字；提交时不会截断选段）":""):"";
    const input=dialog.querySelector(".mai-input");input.value=question;dialog.querySelector(".mai-cancel").hidden=true;
    if(!dialog.open){lastFocus=document.activeElement;dialog.showModal();}input.focus();updateAvailability();
    return dialog;
  }

  let pageController=null, activeMain=null;
  function pageReady({signal,onCleanup}={}){
    const main=document.querySelector("main")||document.body;
    if(main===activeMain&&pageController&&!pageController.signal.aborted)return;
    pageController?.abort();pageController=new AbortController();const own=pageController;
    activeMain=main;
    const dispose=()=>own.abort();signal?.addEventListener("abort",dispose,{once:true});onCleanup?.(dispose);
    document.getElementById("miku-article-tools")?.remove();
    document.getElementById("miku-writing-workshop")?.remove();
    if(document.body.dataset.page==="post"){
      const prose=document.querySelector(".article-inner .prose"),heading=document.querySelector(".article-title");
      if(prose&&heading&&!document.getElementById("miku-article-tools")){
        const tools=make("div","mai-article-tools");tools.id="miku-article-tools";
        tools.appendChild(make("span","mai-tools-label","✦ 和 Miku 一起读"));
        const summary=button("一句话读懂","mai-chip"),question=button("问问这篇","mai-chip"),explain=button("解释选中内容","mai-chip");
        summary.addEventListener("click",()=>{open({mode:"article"});runDialogue("用一句话概括这篇文章的核心内容，并给出引用。");},{signal:own.signal});
        question.addEventListener("click",()=>open({mode:"article"}),{signal:own.signal});
        let selected="";
        document.addEventListener("selectionchange",()=>{const selection=window.getSelection();if(selection?.rangeCount&&prose.contains(selection.anchorNode)&&prose.contains(selection.focusNode))selected=selection.toString().trim();},{signal:own.signal});
        explain.addEventListener("click",()=>{if(!selected){open({mode:"article",question:"我想了解这篇文章中的一个细节："});return;}if(selected.length>MAX_SELECTION){open({mode:"article"});dialog.querySelector(".mai-messages").appendChild(make("p","mai-error","选段超过 8000 字，请缩短后再解释；本次未发送，也没有截断选段。"));return;}open({mode:"article",selection:selected});runDialogue("请结合全文解释这段话，必要时说明上下文。");},{signal:own.signal});
        tools.append(summary,question,explain);heading.insertAdjacentElement("afterend",tools);
      }
    }
    if(document.body.dataset.page==="admin"&&document.getElementById("p-body")&&!document.getElementById("miku-writing-workshop"))buildWorkshop(own.signal);
  }
  function buildWorkshop(signal){
    const body=document.getElementById("p-body"),editor=body.closest(".editor-split")||body;
    const workshop=make("section","mai-workshop");workshop.id="miku-writing-workshop";workshop.setAttribute("aria-labelledby","miku-workshop-title");
    const heading=make("div","mai-workshop-head");heading.append(Object.assign(make("h3","","✦ Miku 的写作便签"),{id:"miku-workshop-title"}),make("span","","只给建议，由你决定"));
    const hint=make("p","mai-workshop-hint","用当前草稿拟标题、提炼摘要，或先选一段正文再润色。建议会先放在下面，不会自动改稿或发布。"),actions=make("div","mai-actions");
    const output=make("div","mai-proposal");output.hidden=true;const notice=make("p","mai-workshop-status");notice.setAttribute("role","status");
    let pending=null,proposal=null,undo=null;
    const tasks={title:["拟标题","请为这篇草稿拟一个贴切的标题，只返回一个标题，不要编号或解释。","p-title"],summary:["提炼摘要","请提炼一段适合博客摘要的简短文字，只返回摘要正文。","p-summary"],polish:["润色选段","保留原意和 Markdown 格式，润色选段，只返回可替换的文字，不要说明。","p-body"]};
    const cancel=button("取消生成","mai-chip");cancel.hidden=true;cancel.addEventListener("click",()=>pending?.abort(),{signal});
    const setBusy=value=>{actions.querySelectorAll("button[data-task]").forEach(el=>el.disabled=value);cancel.hidden=!value;};
    for(const [task,[label,prompt,targetId]] of Object.entries(tasks)){
      const el=button(label,"mai-chip");el.dataset.task=task;
      el.addEventListener("click",async()=>{
        if(pending)return;
        const original=body.value,start=body.selectionStart,end=body.selectionEnd,target=document.getElementById(targetId),before=target.value;
        const selection=task==="polish"?original.slice(start,end):original;
        if(!selection.trim()){notice.textContent=task==="polish"?"先在正文中选中想润色的段落，再点这个按钮。":"先写一点正文，再让我帮忙想想吧。";return;}
        if(selection.length>MAX_SELECTION){notice.textContent="内容超过 8000 字，请先缩短后重试；本次未发送，也不会截断原稿。";return;}
        const controller=pending=new AbortController(),cancelOnLeave=()=>controller.abort();signal.addEventListener("abort",cancelOnLeave,{once:true});setBusy(true);notice.textContent="Miku 正在读你的草稿…";
        try{
          const context={page:"admin",selection};const slug=document.getElementById("p-slug").value.trim();if(slug)context.slug=slug;
          const result=await ask({message:prompt,mode:"write",task,context,signal:controller.signal});
          if(signal.aborted||controller.signal.aborted)return;
          proposal={task,original,start,end,targetId,before};output.replaceChildren();output.hidden=false;
          output.appendChild(make("label","mai-proposal-label","建议文本（可以先修改，再应用）"));
          const text=make("textarea","mai-proposal-text");text.value=result.reply;text.rows=task==="title"?2:5;text.setAttribute("aria-label","Miku 的建议文本");
          const review=make("div","mai-actions"),apply=button(task==="polish"?"替换选中段落":task==="title"?"应用到标题":"应用到摘要","mai-chip mai-apply"),copy=button("复制建议","mai-chip");
          apply.addEventListener("click",()=>{
            const p=proposal,field=document.getElementById(p.targetId);
            if(body.value!==p.original||field.value!==p.before){notice.textContent="草稿已经有新修改了。为保护原稿，请先复制建议，或基于新草稿重新生成。";return;}
            const value=p.task==="polish"?text.value:text.value.trim();if(!value.trim()){notice.textContent="建议为空，暂不修改原稿。";return;}
            if(p.task==="title"&&/[\r\n]/.test(value)){notice.textContent="请在建议框里只保留一个标题，再应用。";return;}
            const after=p.task==="polish"?p.original.slice(0,p.start)+value+p.original.slice(p.end):value;
            undo={field:field.id,before:field.value,after};field.value=after;field.dispatchEvent(new Event("input",{bubbles:true}));apply.disabled=true;
            const revert=button("撤销这次修改","mai-chip mai-undo");revert.addEventListener("click",()=>{const originalField=document.getElementById(undo.field);if(originalField.value!==undo.after){notice.textContent="应用后你又修改了内容，请保留当前草稿。";return;}originalField.value=undo.before;originalField.dispatchEvent(new Event("input",{bubbles:true}));revert.disabled=true;notice.textContent="已恢复应用前的内容。";},{signal});review.appendChild(revert);notice.textContent="已应用建议，草稿会按写作台原有方式自动保存。需要时可以撤销。";
          },{signal});
          copy.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(text.value);notice.textContent="建议已复制，原稿保持原样。";}catch(_){notice.textContent="复制暂时不可用，可以直接选中建议文本复制。";}},{signal});
          review.append(apply,copy);output.append(text,review);notice.textContent="建议已准备好。先看看，再决定是否应用。";
        }catch(error){if(!signal.aborted)notice.textContent=error.name==="AbortError"?"已取消生成，原稿保持原样。":error.message;}
        finally{signal.removeEventListener("abort",cancelOnLeave);if(pending===controller){pending=null;setBusy(false);}}
      },{signal});actions.appendChild(el);
    }
    signal.addEventListener("abort",()=>pending?.abort(),{once:true});actions.appendChild(cancel);workshop.append(heading,hint,actions,notice,output);editor.insertAdjacentElement("afterend",workshop);
  }
  document.addEventListener("pjax:complete",()=>{if(dialog?.open)close();});
  if(typeof onPageReady==="function"){onPageReady(pageReady);if(document.readyState!=="loading")pageReady();}
  else if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>pageReady(),{once:true});else pageReady();
  const ready=refresh();
  window.MikuAI={ready,status,refresh,ask,open,close,renderMessage};
})();
