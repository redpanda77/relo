import assert from "node:assert/strict";
import test from "node:test";
import { notificationHistorySchema } from "../src/dashboard/inbox.js";

const shell={title:"History",description:"",active:"inbox-notifications",releaseIdentity:"test",
  account:{id:"acc_fixture",initial:"F",name:"Fixture",email:"owner@example.test"},
  counts:{pending:0,notifications:0,deliveries:0}};
const pagination={page:1,pageSize:25,total:0,pageCount:1,previousHref:null,nextHref:null};
const history=(filters: Record<string, unknown>, filterOptions: Record<string, unknown> = { projects: [] }) => ({
  version:1,kind:"notification-history",route:{path:"/dashboard/inbox/notifications",page:1,filters},
  filterOptions,shell,notifications:[],pagination,
});

test("history filters speak the owner's words and carry search, source and computer",()=>{
  const parsed=notificationHistorySchema.parse(history(
    {kind:"decision",state:"missed",project:"Relo",source:"Codex",computer:"Studio Mac",q:"deploy"},
    {projects:["Relo"],sources:["Codex","Nightly"],computers:["Studio Mac"]},
  ));
  assert.deepEqual(parsed.route.filters,{kind:"decision",state:"missed",project:"Relo",source:"Codex",computer:"Studio Mac",q:"deploy"});
  assert.deepEqual(parsed.filterOptions.sources,["Codex","Nightly"]);
});

test("history filters default the newer fields to none",()=>{
  const parsed=notificationHistorySchema.parse(history({kind:null,state:null,project:null}));
  assert.deepEqual(parsed.route.filters,{kind:null,state:null,project:null,source:null,computer:null,q:null});
  assert.deepEqual(parsed.filterOptions,{projects:[],sources:[],computers:[]});
});

for (const [field,value] of [["kind","question"],["kind","approval"],["state","active"],["state","responded"]] as const) {
  test(`history rejects the retired ${field} ${value}`,()=>{
    assert.throws(()=>notificationHistorySchema.parse(history({kind:null,state:null,project:null,[field]:value})));
  });
}

test("history keeps the agent sessions that name its handles, ids only",()=>{
  const parsed=notificationHistorySchema.parse({...history({kind:null,state:null,project:null}),namesFrom:["ags_0b9c1d2e-0000-4000-8000-000000000001"]});
  assert.deepEqual(parsed.namesFrom,["ags_0b9c1d2e-0000-4000-8000-000000000001"]);
  assert.throws(()=>notificationHistorySchema.parse({...history({kind:null,state:null,project:null}),namesFrom:["relo"]}));
});
