export const agentUiHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tracey Investigator</title>
  <style>
    :root{color-scheme:dark;--bg:#07100d;--panel:#101a16;--line:#26372f;--text:#e9f4ee;--muted:#9fb1a7;--accent:#78e6ad;--danger:#ff8d8d}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#123527 0,transparent 35%),var(--bg);color:var(--text);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
    main{max-width:1100px;margin:auto;padding:32px 20px}.top{display:flex;justify-content:space-between;gap:20px;align-items:end;border-bottom:1px solid var(--line);padding-bottom:20px}
    h1{font:600 34px/1.1 system-ui;margin:0}.eyebrow{color:var(--accent);text-transform:uppercase;letter-spacing:.14em;font-size:12px}.status{color:var(--muted)}
    .grid{display:grid;grid-template-columns:270px 1fr;gap:18px;margin-top:18px}.panel{background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:12px;padding:16px}
    label{display:block;color:var(--muted);margin:12px 0 5px}input,textarea,button{width:100%;border:1px solid var(--line);border-radius:8px;background:#08110e;color:var(--text);padding:10px;font:inherit}
    button{cursor:pointer;background:var(--accent);color:#06100b;font-weight:700;margin-top:10px}button.secondary{background:transparent;color:var(--text)}button:disabled{opacity:.45;cursor:not-allowed}
    #messages{height:570px;overflow:auto;display:flex;flex-direction:column;gap:12px;padding-right:5px}.message{border-left:3px solid var(--line);padding:10px 13px;white-space:pre-wrap;background:#0a130f;border-radius:0 8px 8px 0}.message.user{border-color:#80a7ff}.message.assistant{border-color:var(--accent)}
    .meta{font-size:11px;color:var(--muted);margin-bottom:5px}.refs{font-size:12px;color:var(--accent);margin-top:8px}.error{color:var(--danger)}form.chat{display:grid;grid-template-columns:1fr 120px;gap:10px;margin-top:12px}form.chat button{margin:0}
    @media(max-width:760px){.grid{grid-template-columns:1fr}.top{align-items:start;flex-direction:column}#messages{height:50vh}form.chat{grid-template-columns:1fr}}
  </style>
</head>
<body><main>
  <div class="top"><div><div class="eyebrow">Production agent observability</div><h1>Tracey Investigator</h1></div><div id="health" class="status">Checking integrations…</div></div>
  <div class="grid">
    <aside class="panel">
      <strong>Connection</strong>
      <label for="token">Tracey API token</label><input id="token" type="password" autocomplete="off" placeholder="Bearer token">
      <label for="title">Investigation title</label><input id="title" value="Production telemetry investigation">
      <button id="newSession">New investigation</button>
      <button id="listAgents" class="secondary">List registered agents</button>
      <p class="status">The token stays in this browser tab. Model tools are read-only, bounded, tenant-scoped, and audited.</p>
      <div id="sessionMeta" class="status"></div>
    </aside>
    <section class="panel">
      <div id="messages"><div class="status">Create an investigation, then ask about an exact Codex conversation, trace, agent, or cohort.</div></div>
      <form id="chat" class="chat"><textarea id="prompt" rows="3" placeholder="Investigate Codex conversation … over the last 24 hours"></textarea><button id="send" disabled>Investigate</button></form>
    </section>
  </div>
</main><script>
let sessionId=null;const token=document.querySelector('#token'),messages=document.querySelector('#messages'),send=document.querySelector('#send');
const headers=()=>({'authorization':'Bearer '+token.value,'content-type':'application/json'});
function add(role,content,refs=[]){const el=document.createElement('div');el.className='message '+role;const meta=document.createElement('div');meta.className='meta';meta.textContent=role;el.append(meta,document.createTextNode(content));if(refs.length){const r=document.createElement('div');r.className='refs';r.textContent='Evidence: '+refs.slice(0,8).map(x=>x.traceId+(x.spanId?'/'+x.spanId:'')).join(', ');el.append(r)}messages.append(el);messages.scrollTop=messages.scrollHeight}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{...headers(),...(options.headers||{})}});const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));return data}
fetch('/health').then(r=>r.json()).then(x=>document.querySelector('#health').textContent='API '+x.status+' · agentic '+x.integrations.agenticInvestigator);
document.querySelector('#newSession').onclick=async()=>{try{const s=await api('/v1/investigations',{method:'POST',body:JSON.stringify({title:document.querySelector('#title').value})});sessionId=s.sessionId;messages.innerHTML='';send.disabled=false;document.querySelector('#sessionMeta').textContent='Session '+sessionId;add('assistant','Investigation ready. I will use only Tracey read tools and verified telemetry evidence.')}catch(e){add('error',e.message)}};
document.querySelector('#listAgents').onclick=async()=>{try{const x=await api('/v1/agents');add('assistant',x.agents.map(a=>a.displayName+' · '+a.producerType+' · '+a.serviceName+' · '+a.agentId).join('\n')||'No registered agents.')}catch(e){add('error',e.message)}};
document.querySelector('#chat').onsubmit=async(e)=>{e.preventDefault();const p=document.querySelector('#prompt');if(!sessionId||!p.value.trim())return;const text=p.value;p.value='';add('user',text);send.disabled=true;send.textContent='Working…';try{const answer=await api('/v1/investigations/'+sessionId+'/messages',{method:'POST',body:JSON.stringify({content:text})});add('assistant',answer.content,answer.evidenceRefs)}catch(err){add('error',err.message)}finally{send.disabled=false;send.textContent='Investigate'}};
</script></body></html>`;
