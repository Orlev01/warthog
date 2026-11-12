import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { createRule } from "../db/rules";
import { decide } from "../db/approvals";
import { createRecord } from "../db/life-admin-records";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createDbRecorder } from "../activity/writer";
import { createAgentCallPipeline } from "./pipeline";
import { createRateLimiter } from "./rate-limit";
import { createToolRegistry } from "./tools/registry";
import { createListRecordsTool, createUpdateRecordTool } from "./tools/records";
import { createCreateTaskTool } from "./tools/tasks";

test("tool allowlists agree in discovery and execution; unknown API semantics cannot bypass an email prohibition", async () => {
 const db=await freshDb();
 try {
  const clock=fixedClock(new Date("2026-11-12T00:00:00Z")),keyWrapper=localAesKeyWrapper(randomBytes(32)),dek=randomBytes(32);
  const user=await createUser(db,{email:"granular@example.test",wrappedDek:await keyWrapper.wrap(dek)});
  const connectionId=randomUUID(), agent=await createAgent(db,{userId:user.id,connectionId,displayName:"Test",platform:"other"},clock);
  const connection={userId:user.id,agentId:agent.id,connectionId,active:true};
  const grants=await upsertPermissions(db,{userId:user.id,connectionId,grantedConnectors:["google-gmail","resend"],readTools:true,changeTools:"allow",identityAccess:true,highTierAccess:false,cardAccess:false,cardBudget:null,skillsScope:[],memoryRead:true,sharing:false,rulesScope:[],rateLimit:120,connectorPolicies:{"google-gmail":{allowedTools:["google-gmail__search"]}}});
  let executed=0;
  const pipeline=createAgentCallPipeline({db,keyWrapper,clock,recorder:createDbRecorder({db,clock,dekFor:async()=>dek}),rateLimiter:createRateLimiter(clock),executeTool:async()=>{executed++;return {status:200};}});
  const registry=createToolRegistry({pipeline});
  const toolset={"google-gmail":[{name:"search",makesChange:false},{name:"read",makesChange:false},{name:"new_tool",makesChange:false}],resend:[{name:"request"}]};
  const tools=registry.resolveTools(grants,toolset,{expanded:true});
  assert.ok(tools.some(t=>t.name==="google-gmail__search"));
  assert.ok(!tools.some(t=>t.name==="google-gmail__read"||t.name==="google-gmail__new_tool"));
  assert.equal((await pipeline.handleAgentCall(connection,{connector:"google-gmail",tool:"google-gmail__read",makesChange:false})).status,"refused");
  await upsertPermissions(db,{...grants,connectorPolicies:{"google-gmail":{allowedTools:["google-gmail__read","google-gmail__search"]}}});
  const held = await pipeline.handleAgentCall(connection,{connector:"google-gmail",tool:"google-gmail__read",makesChange:false,requiresApproval:true});
  assert.equal(held.status,"pending_approval");
  if (held.status === "pending_approval") {
    await decide(db,{userId:user.id,id:held.approval_id,decision:{status:"approved"}},dek,clock);
    await upsertPermissions(db,grants);
    assert.equal((await pipeline.executeApprovedHold(user.id,held.approval_id)).status,"refused","a previous approval cannot override a revoked tool");
  }
  await createRule(db,{userId:user.id,kind:"never_allow",scope:{type:"any_agent"},action:{type:"send_message",channel:"email"}},dek);
  const generic=tools.find(t=>t.name==="resend__request")!;
  assert.equal((await generic.handle({method:"POST",path:"/emails",body:'{"to":"someone@example.test"}'},connection)).status,"refused");
  assert.equal(executed,0);
  const first=await createRecord(db,{userId:user.id,kind:"subscription",fields:{title:"Chosen"},status:"active",dueDate:null,source:{kind:"person"}},dek);
  const second=await createRecord(db,{userId:user.id,kind:"subscription",fields:{title:"Private"},status:"active",dueDate:null,source:{kind:"person"}},dek);
  await upsertPermissions(db,{...grants,tasksAccess:true,recordsAccess:true,resourceControls:{tasksWrite:false,recordsWrite:false,recordIds:[first.id]}});
  const list=await createListRecordsTool({db,keyWrapper}).handle({},connection);
  assert.equal(list.status,"ok"); if(list.status==="ok") assert.deepEqual(list.records.map(r=>r.id),[first.id]);
  assert.equal((await createUpdateRecordTool({db,keyWrapper}).handle({id:first.id,fields:{title:"Change"}},connection)).status,"refused");
  assert.equal((await createCreateTaskTool({db,keyWrapper}).handle({title:"Change"},connection)).status,"refused");
  await upsertPermissions(db,{...grants,tasksAccess:true,recordsAccess:true,resourceControls:{recordsWrite:true,recordIds:[first.id]}});
  assert.equal((await createUpdateRecordTool({db,keyWrapper}).handle({id:second.id,fields:{title:"Forbidden"}},connection)).status,"refused");
 } finally {await db.close();}
});
