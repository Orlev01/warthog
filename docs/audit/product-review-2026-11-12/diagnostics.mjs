// Diagnostic characterization of the reviewed baseline, not acceptance tests for fixes.
// Synthetic in-memory data only; no production credentials, calls or customer content.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {freshDb} from '../../../src/test/db.ts';
import {createUser} from '../../../src/server/db/users.ts';
import {createAgent} from '../../../src/server/db/agents.ts';
import {upsertPermissions} from '../../../src/server/db/agent-permissions.ts';
import {localAesKeyWrapper} from '../../../src/server/crypto/key-wrapper.ts';
import {fixedClock} from '../../../src/server/seams/clock.ts';
import {createSession} from '../../../src/server/auth/session.ts';
import {systemRandom} from '../../../src/server/seams/random.ts';
import {createDbRecorder, readActivity} from '../../../src/server/activity/writer.ts';
import {createDisputeRepo} from '../../../src/server/activity/disputes.ts';
import {createAgentCallPipeline} from '../../../src/server/mcp/pipeline.ts';
import {createRateLimiter} from '../../../src/server/mcp/rate-limit.ts';
import {createGetContextTool} from '../../../src/server/mcp/tools/get-context.ts';
import {createLogActivityTool} from '../../../src/server/mcp/tools/log-activity.ts';
import {createActivityActions} from '../../../src/app/(portal)/(protected)/activity/actions.ts';
import {createRulesActions} from '../../../src/app/(portal)/(protected)/rules/actions.ts';
import {createMemoryActions} from '../../../src/app/(portal)/(protected)/memory/actions.ts';
import {checkIntegrity} from '../../../src/server/activity/integrity.ts';
import {evaluate} from '../../../src/domain/policy/evaluate.ts';

const db=await freshDb();
const observations={};
try {
  const clock=fixedClock(new Date('2026-11-12T01:30:00Z'));
  const keyWrapper=localAesKeyWrapper(randomBytes(32)),dek=randomBytes(32);
  const user=await createUser(db,{email:'product-review@example.test',wrappedDek:await keyWrapper.wrap(dek)});
  const connectionId=randomUUID();
  const agent=await createAgent(db,{userId:user.id,connectionId,displayName:'Synthetic agent',platform:'other'},clock);
  const connection={userId:user.id,connectionId,agentId:agent.id,active:true};
  await upsertPermissions(db,{userId:user.id,connectionId,grantedConnectors:['google-gmail'],readTools:true,changeTools:'ask_first',identityAccess:true,highTierAccess:false,cardAccess:false,cardBudget:null,skillsScope:[],memoryRead:true,sharing:false,rulesScope:[],rateLimit:120});
  const recorder=createDbRecorder({db,clock,dekFor:async()=>dek});
  const disputes=createDisputeRepo({db,clock,dekFor:async()=>dek});
  const session=(await createSession(db,user.id,{clock,random:systemRandom})).session;
  const loader=createActivityActions({db,disputes,undo:{undo:async()=>({ok:false,reason:'Not used'})},keyWrapper});
  const metrics=[];
  let execute=async()=>({status:200,body:'{"messages":[{"id":"synthetic-message"}]}',truncated:false});
  const pipeline=createAgentCallPipeline({db,keyWrapper,clock,recorder,rateLimiter:createRateLimiter(clock),executeTool:()=>execute(),recordMetric:async m=>{metrics.push(m);}});
  const call={connector:'google-gmail',tool:'google-gmail__search',makesChange:false,reason:'Review synthetic inbox',params:{query:{q:'in:inbox',maxResults:'15'},reason:'Review synthetic inbox'}};

  await pipeline.handleAgentCall(connection,call);
  const entries=await readActivity(db,user.id,dek);
  const view=await loader.load(session,{agent:agent.id});
  assert.equal(entries[0].payload.reason,call.reason);
  assert.equal(view.entries[0].summary,''); assert.equal(view.entries[0].detail,'');
  observations.audit_display={storedReason:true,storedParams:true,displayedSummary:view.entries[0].summary,displayedDetail:view.entries[0].detail};
  const searched=await loader.load(session,{q:'inbox'});assert.equal(searched.entries.length,0);
  observations.reason_search={matches:searched.entries.length,storedMatchingReason:true};

  execute=async()=>({status:500,body:'{"error":"synthetic upstream error"}',truncated:false});
  const httpFailure=await pipeline.handleAgentCall(connection,call);assert.equal(httpFailure.status,'executed');
  observations.http_failure={upstreamStatus:500,pipelineOutcome:httpFailure.status};
  execute=async()=>({isError:true,content:[{type:'text',text:'Synthetic provider failure'}]});
  const providerFailure=await pipeline.handleAgentCall(connection,call);assert.equal(providerFailure.status,'executed');
  observations.provider_failure={upstreamIsError:true,pipelineOutcome:providerFailure.status};

  const countBefore=(await readActivity(db,user.id,dek)).length;
  const metricsBefore=metrics.length;
  execute=async()=>{throw new Error('Synthetic transport timeout');};
  await assert.rejects(()=>pipeline.handleAgentCall(connection,call));
  const countAfter=(await readActivity(db,user.id,dek)).length;assert.equal(countAfter,countBefore);
  assert.ok(metrics.length>metricsBefore);
  observations.thrown_failure={activityEntriesAdded:countAfter-countBefore,metricEmitted:metrics.length>metricsBefore};

  let simulatedSideEffects=0;
  const failingRecorder=createAgentCallPipeline({db,keyWrapper,clock,rateLimiter:createRateLimiter(clock),recorder:{record:async()=>{throw new Error('Synthetic audit failure');}},executeTool:async()=>{simulatedSideEffects++;return {ok:true};}});
  await assert.rejects(()=>failingRecorder.handleAgentCall(connection,call));
  assert.equal(simulatedSideEffects,1);
  observations.audit_write_failure={simulatedSideEffectOccurred:true,callReturnedError:true};

  const context=await createGetContextTool({db,keyWrapper,clock}).handle(connection,{});
  assert.equal(context.skills[0].title,'Using Warthog');
  assert.equal('text' in context.skills[0],false);
  observations.agent_context={fields:Object.keys(context),houseSkillFields:Object.keys(context.skills[0]),services:context.permissions.services};

  const report=await createLogActivityTool({recorder}).handle({reason:'Synthetic outcome summary'},connection);
  const reportView=(await loader.load(session,{})).entries.find(e=>e.seq===report.seq);
  assert.equal(reportView.summary,''); assert.equal(reportView.detail,'');
  observations.agent_report={labelledAsReported:reportView.source==='agent_reported',displayedSummary:reportView.summary,displayedDetail:reportView.detail};

  const limited=createActivityActions({db,disputes,undo:{undo:async()=>({ok:false,reason:'Not used'})},keyWrapper,pageLimit:2});
  const first=await limited.load(session,{}),second=await limited.load(session,{before:'1',cursor:'1'});
  assert.deepEqual(second.entries.map(e=>e.seq),first.entries.map(e=>e.seq));
  observations.history_paging={pageSize:2,totalEntries:(await readActivity(db,user.id,dek)).length,continuationProvided:false,attemptedContinuationReturnsSameEntries:true};

  await disputes.fileDispute({userId:user.id,entrySeq:report.seq,note:'Synthetic dispute'});
  const afterDispute=(await loader.load(session,{})).entries.find(e=>e.seq===report.seq);
  assert.deepEqual(afterDispute,reportView);
  observations.dispute_display={saved:true,activityViewUnchanged:true};
  observations.metric_dimensions=[...new Set(metrics.flatMap((m)=>Object.keys(m.dimensions??{})))];

  const genericDecision=evaluate({connector:'resend',tool:'resend__request',makesChange:true},{connectionActive:true,agentId:connectionId,permission:{connectorGranted:true,grantedTools:['resend__request'],readsAllowed:true,changes:'allow',highTierAllowed:false},rules:[{id:'synthetic-rule',kind:'never_allow',scope:{type:'any_agent'},action:{type:'send_message',channel:'email'}}],accountCurrency:'AUD',rate:null,now:clock.now()});
  assert.equal(genericDecision.decision,'allow');
  observations.generic_message_rule={genericChangeWithUnknownMessageSemantics:true,configuredNeverAllowEmail:true,changePolicy:'allow',decision:genericDecision.decision};

  const beforeChanges=(await readActivity(db,user.id,dek)).length;
  const rules=createRulesActions({db,clock,keyWrapper});
  assert.deepEqual(await rules.createRule(session,{kind:'never_allow',scope:{type:'any_agent'},action:{type:'any_change'}}),{ok:true});
  const memories=createMemoryActions({db,clock,keyWrapper});
  assert.deepEqual(await memories.addMemory(session,{content:'Synthetic user-created fact',scope:'shared'}),{ok:true});
  const afterChanges=(await readActivity(db,user.id,dek)).length;
  assert.equal(beforeChanges,afterChanges);
  observations.owner_changes={ruleSaved:true,memorySaved:true,activityEntriesAdded:afterChanges-beforeChanges};

  // This intentionally uses the privileged SYNTHETIC test DB, not the production
  // runtime role (which cannot delete audit rows). Demonstrates the anchor boundary.
  const tail=await recorder.record({userId:user.id,kind:'synthetic_tail',source:'warthog',payload:{summary:'Synthetic tail'}});
  const beforeDeletion=await checkIntegrity(db,user.id);
  await db.query('DELETE FROM activity_entries WHERE user_id = $1 AND seq = $2',[user.id,tail.seq]);
  const afterDeletion=await checkIntegrity(db,user.id);
  assert.equal(beforeDeletion.intact,true);assert.equal(afterDeletion.intact,true);
  observations.tail_deletion={requiresPrivilegedDatabaseAccess:true,before:beforeDeletion,after:afterDeletion};
  await writeFile(new URL('../../../.delivery/product-review/probe-results.json',import.meta.url),JSON.stringify(observations,null,2)+'\n');
  console.log(JSON.stringify(observations,null,2));
} finally {await db.close();}
