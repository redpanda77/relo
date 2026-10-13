import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe,expect,test,vi } from "vitest";
import { Hono } from "hono";
import { CurrentChangeHub,CurrentChangeSubscription } from "./current-change-hub.js";
import { ApiChangeListener } from "./api-change-listener.js";
import { currentStateStream } from "./current-state-stream.js";

describe("bounded current change signals",()=>{
  test("first hint is immediate, duplicate IDs merge and overflow invalidates once",async()=>{
    const closed=vi.fn(),sub=new CurrentChangeSubscription(closed),id=`sub_${randomUUID()}`;
    const wait=sub.wait(1000);sub.notify(id);await expect(wait).resolves.toBe("changed");
    expect(sub.take()).toEqual({subjectIds:[id],invalidateCounts:true});
    sub.notify(id);sub.notify(id);await sub.wait(1000);expect(sub.take().subjectIds).toEqual([id]);
    for(let i=0;i<51;i++)sub.notify(`sub_${randomUUID()}`);
    await sub.wait(1000);expect(sub.take().subjectIds).toEqual([]);
    expect(await sub.wait(1)).toBe("timeout");sub.close();sub.close();expect(closed).toHaveBeenCalledOnce();
  });
  test("bootstrap, account isolation, malformed payloads, connection caps and shutdown",async()=>{
    const hub=new CurrentChangeHub(),own=hub.subscribe("a","one")!,other=hub.subscribe("b","two")!;
    await own.wait(100);await other.wait(100);expect(own.take().subjectIds).toEqual([]);other.take();
    const id=`ntf_${randomUUID()}`;
    hub.receive({channel:"relo_current_changes",processId:1,payload:JSON.stringify({principalId:"a",subjectId:id})});
    expect(await own.wait(100)).toBe("changed");expect(own.take().subjectIds).toEqual([id]);
    expect(await other.wait(1)).toBe("timeout");
    for(const payload of ["{",JSON.stringify({principalId:"a",subjectId:"private text"}),"x".repeat(300)])hub.receive({channel:"relo_current_changes",processId:1,payload});
    expect(await own.wait(1)).toBe("timeout");
    for(let i=0;i<15;i++)expect(hub.subscribe("a","one")).not.toBeNull();
    expect(hub.subscribe("a","one")).toBeNull();own.close();expect(hub.subscribe("a","one")).not.toBeNull();
    const waiting=other.wait(1000);hub.close();await expect(waiting).resolves.toBe("aborted");expect(hub.subscribe("a","new")).toBeNull();
  });
  test("API multiplexes both channels on one reconnecting connection",async()=>{
    class Client extends EventEmitter {channels:string[]=[];released=0;async query(sql:string){this.channels.push(sql);}release(){this.released++;}}
    const first=new Client(),second=new Client();let connects=0;
    const api=await ApiChangeListener.listen({connect:async()=>++connects===1?first:second} as never);
    const current=api.current.subscribe("a","c")!,decision=api.interactions.subscribe("a","r","c")!;
    await current.wait(100);current.take();
    expect(connects).toBe(1);expect(first.channels).toEqual(["LISTEN relo_interaction_changes","LISTEN relo_current_changes"]);
    first.emit("notification",{channel:"relo_interaction_changes",payload:JSON.stringify({principalId:"a",interactionId:"r"})});
    expect(await decision.wait(100)).toBe("changed");expect(await current.wait(1)).toBe("timeout");
    first.emit("error",new Error("connection lost"));
    expect(await current.wait(100)).toBe("changed");current.take();
    expect(await current.wait(2000)).toBe("changed");expect(current.take().subjectIds).toEqual([]);
    expect(connects).toBe(2);expect(second.channels).toEqual(first.channels);
    await api.close();expect(first.released).toBe(1);expect(second.released).toBe(1);
  });
  test("missed hints reconcile periodically; keepalive carries no data; cancellation releases slots",async()=>{
    const hub=new CurrentChangeHub(),app=new Hono(),actor={principalId:randomUUID(),credentialId:randomUUID(),credentialKind:"principal" as const,scopes:new Set(["inbox:read"])};
    app.get("/",c=>{c.set("auth",actor);return currentStateStream(c,{query:async()=>({rows:[{allowed:true}]})} as never,hub,{keepaliveMs:5,reconcileMs:20,writeTimeoutMs:100});});
    const abort=new AbortController(),response=await app.request("/",{signal:abort.signal}),reader=response.body!.getReader(),decode=new TextDecoder();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(decode.decode((await reader.read()).value)).toContain('"subjectIds":[]');
    expect(decode.decode((await reader.read()).value)).toBe(": keepalive\n\n");
    let text="";for(let i=0;i<10 && !text.includes("event: current");i++)text=decode.decode((await reader.read()).value);
    expect(text).toContain('"subjectIds":[]');abort.abort();await reader.cancel();
    for(let i=0;i<16;i++)expect(hub.subscribe(actor.principalId,`principal:${actor.credentialId}`)).not.toBeNull();hub.close();
  });
  test("a client that stops reading cannot retain a stream slot indefinitely",async()=>{
    const hub=new CurrentChangeHub(),app=new Hono();
    app.get("/",c=>{c.set("auth",{principalId:"p",credentialId:"c",credentialKind:"principal",scopes:new Set(["inbox:read"])});return currentStateStream(c,{query:async()=>({rows:[{allowed:true}]})} as never,hub,{keepaliveMs:1,reconcileMs:1,writeTimeoutMs:15});});
    const response=await app.request("/");
    // Fill all remaining slots, then await the stalled writer's bounded release.
    const slots=Array.from({length:15},()=>hub.subscribe("p","principal:c"));expect(slots.every(Boolean)).toBe(true);
    expect(hub.subscribe("p","principal:c")).toBeNull();
    await vi.waitFor(()=>expect(hub.subscribe("p","principal:c")).not.toBeNull(),{timeout:500,interval:20});
    await response.body!.cancel();hub.close();
  });
});
