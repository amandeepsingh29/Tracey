import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { PostgresStore } from "@tracey/postgres-store";
import { z } from "zod";

dotenv.config({path:new URL("../../../.env",import.meta.url),quiet:true});
const config=z.object({DATABASE_URL:z.string().min(1),TRACEY_API_URL:z.string().url().default("http://api:3000"),
  TRACEY_API_BEARER_TOKEN:z.string().min(1),TRACEY_TENANT_ID:z.string().min(1).max(128).default("local"),
  TRIGGER_POLL_INTERVAL_MS:z.coerce.number().int().min(5_000).max(300_000).default(30_000),WORKER_HEALTH_PORT:z.coerce.number().int().min(1).max(65535).default(3001)}).parse(process.env);
const store=new PostgresStore({connectionString:config.DATABASE_URL});
const workerId=`worker:${randomUUID()}`;let lastPoll:string|undefined;let lastError:string|undefined;let polling=false;
async function api(path:string,init?:RequestInit){return fetch(`${config.TRACEY_API_URL.replace(/\/$/,"")}${path}`,{...init,headers:{authorization:`Bearer ${config.TRACEY_API_BEARER_TOKEN}`,"content-type":"application/json",...(init?.headers??{})}});}
async function poll(){if(polling)return;polling=true;try{const rules=await store.claimDueTriggerRules(config.TRACEY_TENANT_ID,workerId,10);for(const rule of rules){try{const agent=await store.getAgent(config.TRACEY_TENANT_ID,rule.agentId);if(!agent||["codex_desktop","codex_cli"].includes(agent.producerType))continue;
  const end=Date.now(),start=end-rule.lookbackMinutes*60_000;const response=await api(`/v1/agents/${agent.agentId}/runs?start=${start}&end=${end}&limit=20`);if(!response.ok)continue;
  const body=await response.json() as {runs?:Array<{traceId:string}>};for(const run of body.runs??[]){await api(`/v1/triggers/${rule.triggerId}/fire`,{method:"POST",body:JSON.stringify({correlationType:"trace",correlationId:run.traceId,start,end})});}
}finally{await store.completeTriggerPoll(config.TRACEY_TENANT_ID,rule.triggerId,workerId);}}const scheduled=await store.listDueScheduledActions(config.TRACEY_TENANT_ID,20);for(const action of scheduled){const response=await api(`/v1/actions/${action.proposalId}/execute`,{method:"POST",body:"{}"});if(!response.ok&&response.status!==409)throw new Error(`Scheduled action ${action.proposalId} returned HTTP ${response.status}`);}lastPoll=new Date().toISOString();lastError=undefined;}finally{polling=false;}}
async function runPoll(){try{await poll();}catch(error){lastError=error instanceof Error?error.name:"UnknownError";console.error("Trigger poll failed",{error:lastError});}}
const timer=setInterval(()=>void runPoll(),config.TRIGGER_POLL_INTERVAL_MS);timer.unref();void runPoll();
const health=createServer((_req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({status:lastError?"degraded":"ok",workerId,polling,lastPoll,lastError}));});health.listen(config.WORKER_HEALTH_PORT,"0.0.0.0");
async function shutdown(){clearInterval(timer);health.close();await store.close();process.exit(0);}process.once("SIGTERM",()=>void shutdown());process.once("SIGINT",()=>void shutdown());
