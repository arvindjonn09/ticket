import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/database.js';
import { TicketsService } from '../src/tickets.js';
import { RequestsService } from '../src/requests.js';
import type { AuthContext } from '../src/auth.js';
import type { CatalogItem, TicketDetail } from '@astrama/contracts';

describe.skipIf(!process.env.DATABASE_URL||!process.env.MIGRATION_DATABASE_URL)('request workflow — real PostgreSQL tenant runtime',()=>{
  const owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
  const db=new Database(),tickets=new TicketsService(db),requests=new RequestsService(tickets);
  const tenants:string[]=[];let tenantId:string,departmentId:string,securityId:string,otherGroupId:string,categoryId:string,securityCategoryId:string,foreignUserId:string;
  let employee:AuthContext,recipient:AuthContext,manager:AuthContext,vp:AuthContext,delegate:AuthContext,agent:AuthContext,outsider:AuthContext,admin:AuthContext,foreignAuth:AuthContext,foreignItemId:string;
  let normal:CatalogItem,approved:CatalogItem,vpItem:CatalogItem,alternate:CatalogItem;
  const identity=(user:{id:string;name:string;email:string;role:string},tenant:string):AuthContext=>({id:user.id,tenantId:tenant,role:user.role as AuthContext['role'],departmentIds:[],sessionId:randomUUID(),view:{user:{id:user.id,name:user.name,email:user.email,role:user.role as AuthContext['role'],departmentIds:[]},tenant:{id:tenant,name:'Test',slug:'test',brandName:'Astrama'},csrfToken:'test',mfaVerified:true}});
  const create=(item=approved,actor=employee,extra:Record<string,unknown>={})=>requests.create(actor,{itemId:item.id,requestedForId:recipient.id,quantity:1,summary:'A requested application',description:'Business application access is needed',...extra},randomUUID());
  const decisions=(ticket:TicketDetail)=>ticket.approvals.filter(a=>a.version===ticket.approvalVersion);
  beforeAll(async()=>{
    await db.assertRuntimeRole();
    for(let index=0;index<2;index++){
      const tenant=await owner.tenant.create({data:{slug:`requests-${randomUUID()}`,name:'Requests test',brandName:'Astrama'}});tenants.push(tenant.id);
      if(index){
        const user=await owner.user.create({data:{tenantId:tenant.id,name:'Foreign',email:'foreign@test.invalid',role:'agent',passwordHash:'disabled',approverEligible:true,isVp:true}});foreignUserId=user.id;foreignAuth=identity(user,tenant.id);
        await owner.session.create({data:{id:foreignAuth.sessionId,tenantId:tenant.id,userId:user.id,tokenHash:randomUUID(),csrfToken:'test',expiresAt:new Date(Date.now()+3600000)}});
        const department=await owner.department.create({data:{tenantId:tenant.id,name:'Other triage',isTriage:true}});await owner.membership.create({data:{tenantId:tenant.id,userId:user.id,departmentId:department.id}});
        const category=await owner.category.create({data:{tenantId:tenant.id,name:'Other software',departmentId:department.id}});
        foreignItemId=(await owner.catalogItem.create({data:{tenantId:tenant.id,categoryId:category.id,name:'Other service',currency:'AUD'}})).id;continue;
      }
      tenantId=tenant.id;
      const people:AuthContext[]=[];
      for(const [name,role,eligible,isVp]of [['Employee','employee',false,false],['Recipient','employee',false,false],['Manager','employee',true,false],['VP','employee',true,true],['Delegate','employee',true,true],['Agent','agent',false,false],['Outsider','agent',false,false],['Admin','admin',false,false]] as const){
        const person=identity(await owner.user.create({data:{tenantId,name,email:`${name.toLowerCase()}@test.invalid`,role,passwordHash:'disabled',approverEligible:eligible,isVp,mfaEnrolled:role==='admin',mfaSecret:role==='admin'?'test-secret':null}}),tenantId);
        await owner.session.create({data:{id:person.sessionId,tenantId,userId:person.id,tokenHash:randomUUID(),csrfToken:'test',mfaVerified:role==='admin',expiresAt:new Date(Date.now()+3600000)}});people.push(person);
      }
      [employee,recipient,manager,vp,delegate,agent,outsider,admin]=people as [AuthContext,AuthContext,AuthContext,AuthContext,AuthContext,AuthContext,AuthContext,AuthContext];
      await owner.user.update({where:{id:recipient.id},data:{managerId:manager.id}});
      departmentId=(await owner.department.create({data:{tenantId,name:'Service Desk',isTriage:true,queueOwnerId:agent.id}})).id;
      securityId=(await owner.department.create({data:{tenantId,name:'Security'}})).id;
      otherGroupId=(await owner.department.create({data:{tenantId,name:'Other'}})).id;
      for(const [userId,groupId]of [[agent.id,departmentId],[agent.id,securityId],[outsider.id,otherGroupId]])await owner.membership.create({data:{tenantId,userId:userId!,departmentId:groupId!}});
      categoryId=(await owner.category.create({data:{tenantId,name:'Software',departmentId}})).id;
      securityCategoryId=(await owner.category.create({data:{tenantId,name:'Sensitive',departmentId:securityId,sensitive:true}})).id;
      const config={categoryId,unitCostMinor:1000,currency:'AUD',recurringPeriod:null,requiresManager:false,requiresVp:false,vpThresholdMinor:null,vpApproverId:vp.id,alternateApproverId:null};
      normal=await requests.item(admin,{...config,name:'No approval'});
      approved=await requests.item(admin,{...config,name:'Manager approval',requiresManager:true});
      vpItem=await requests.item(admin,{...config,name:'Spend threshold',requiresManager:true,vpThresholdMinor:2000});
      alternate=await requests.item(admin,{...config,name:'Alternate approval',requiresManager:true,alternateApproverId:delegate.id});
    }
  });
  afterAll(async()=>{
    await db.$disconnect();
    for(const id of tenants){
      await owner.user.updateMany({where:{tenantId:id},data:{managerId:null}});await owner.department.updateMany({where:{tenantId:id},data:{queueOwnerId:null,substituteId:null}});
      for(const table of ['notification_deliveries','attachments','approval_delegations','approvals','idempotency','outbox','audits','config_audits','activities','tickets','catalog_items','sessions','memberships','subcategories','categories','counters','departments','users','tenants'])await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${table==='tenants'?'id':'tenant_id'}"=$1::uuid`,id);
    }await owner.$disconnect();
  });
  it('requires MFA administrator configuration and same-tenant approvers',async()=>{
    const input={...normal,name:'Invalid approval',vpApproverId:foreignUserId};delete (input as Partial<CatalogItem>).id;delete (input as Partial<CatalogItem>).revision;
    await expect(requests.item(employee,input)).rejects.toThrow('MFA-verified administrator');
    await expect(requests.items({...admin,view:{...admin.view,mfaVerified:false}})).rejects.toThrow('MFA-verified administrator');
    await expect(requests.item(admin,input)).rejects.toThrow('organisation');
  });
  it('concurrent submissions allocate independent INC/SR sequences and retry one result',async()=>{
    const payload={itemId:normal.id,requestedForId:recipient.id,quantity:1,summary:'Concurrent request submission',description:'Concurrent service request submission'},key=randomUUID();
    const retried=await Promise.all(Array.from({length:5},()=>requests.create(employee,payload,key)));
    expect(new Set(retried.map(t=>t.id)).size).toBe(1);expect(retried[0]!.number).toBe('SR0001');
    const incident=await tickets.create(employee,{categoryId,summary:'Concurrent incident creation',description:'An incident independent of service requests'},key);expect(incident.number).toBe('INC0001');
    const batch=await Promise.all(Array.from({length:5},()=>create(normal)));expect(new Set(batch.map(t=>t.number)).size).toBe(5);
    await expect(requests.create(employee,{...payload,quantity:2},key)).rejects.toThrow('different content');
    expect(await owner.outbox.count({where:{tenantId,ticketId:retried[0]!.id,event:'request.created'}})).toBe(1);
    await expect(create(normal,employee,{requestedForId:foreignUserId})).rejects.toThrow('organisation');
    expect(await owner.counter.findUnique({where:{tenantId_type:{tenantId,type:'request'}}})).toMatchObject({sequence:6});
    const other=await requests.create(foreignAuth,{itemId:foreignItemId,requestedForId:foreignUserId,quantity:1,summary:'Independent tenant request',description:'Another tenant starts a separate request sequence'},key);expect(other.number).toBe('SR0001');
    await expect(tickets.get(foreignAuth,retried[0]!.id)).rejects.toThrow('not found');
    await expect(tickets.get(employee,other.id)).rejects.toThrow('not found');
  });
  it('manager then VP approvals gate fulfilment, record identities, and keep internal notes private',async()=>{
    let ticket=await create(vpItem,employee,{quantity:2});expect(ticket.state).toBe('Pending Approval');expect(ticket.departmentId).toBe(departmentId);
    const stages=decisions(ticket);expect(stages.map(a=>a.stage)).toEqual(['manager','vp']);
    await expect(tickets.state(agent,ticket.id,{revision:ticket.revision,state:'In Progress'})).rejects.toThrow();
    await expect(requests.decide(vp,stages[1]!.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Approved'})).rejects.toThrow('Manager approval');
    expect((await requests.queue(vp)).approvals.some(a=>a.ticketId===ticket.id)).toBe(false);
    ticket=await tickets.message(agent,ticket.id,{revision:ticket.revision,audience:'internal',body:'PRIVATE fulfilment credentials'});
    expect((await tickets.get(manager,ticket.id)).activities).toEqual([]);
    ticket=await requests.decide(manager,stages[0]!.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Approved'});expect(ticket.state).toBe('Pending Approval');
    expect((await requests.queue(vp)).approvals.some(a=>a.ticketId===ticket.id)).toBe(true);
    ticket=await requests.decide(vp,stages[1]!.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Approved'});expect(ticket.state).toBe('Open');
    expect(decisions(ticket).map(a=>a.decidedById)).toEqual([manager.id,vp.id]);
    await expect(requests.decide(vp,stages[1]!.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Approved'})).rejects.toThrow('changed');
    ticket=await tickets.state(agent,ticket.id,{revision:ticket.revision,state:'In Progress'});
    await expect(tickets.state(agent,ticket.id,{revision:ticket.revision,state:'Complete'})).rejects.toThrow('resolution');
    ticket=await tickets.state(agent,ticket.id,{revision:ticket.revision,state:'Complete',resolution:'Internal completion',customerSummary:'Access is available'});
    expect((await tickets.get(recipient,ticket.id)).activities.some(a=>a.body.includes('PRIVATE')||a.body==='Internal completion')).toBe(false);
    await expect(tickets.message(employee,ticket.id,{revision:ticket.revision,audience:'customer',body:'Terminal message'})).rejects.toThrow('not permitted');
  });
  it('missing approvers stay pending with a correction and administrators can re-evaluate without content access',async()=>{
    await owner.user.update({where:{id:recipient.id},data:{managerId:null}});
    const ticket=await create();expect(ticket.state).toBe('Pending Approval');expect(ticket.approvalCorrectionReason).toContain('Missing eligible manager');
    expect((await requests.corrections(admin)).tickets.some(t=>t.id===ticket.id)).toBe(true);
    await expect(tickets.get(admin,ticket.id)).rejects.toThrow('not found');
    await owner.user.update({where:{id:recipient.id},data:{managerId:manager.id}});
    await requests.correct(admin,ticket.id,{revision:ticket.revision,reason:'Manager directory record corrected'});
    const refreshed=await tickets.get(employee,ticket.id);expect(refreshed.approvalVersion).toBe(ticket.approvalVersion+1);expect(refreshed.approvalCorrectionReason).toBeNull();
    expect(refreshed.approvals.some(a=>a.status==='Invalidated')).toBe(true);
  });
  it('self-approval uses configured alternate; manager equal to VP has one decision',async()=>{
    const ticket=await create(alternate,manager);expect(decisions(ticket)[0]!.approverId).toBe(delegate.id);
    await expect(requests.decide(manager,decisions(ticket)[0]!.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Approved'})).rejects.toThrow('not found');
    await owner.user.update({where:{id:recipient.id},data:{managerId:vp.id}});
    const combined=await create(vpItem,employee,{quantity:2});expect(decisions(combined).map(a=>a.stage)).toEqual(['vp']);
    const done=await requests.decide(vp,decisions(combined)[0]!.id,{revision:combined.revision,version:combined.approvalVersion,decision:'Approved'});expect(done.state).toBe('Open');
    await owner.user.update({where:{id:recipient.id},data:{managerId:manager.id}});
  });
  it('material cost changes invalidate approvals, stale decisions conflict, cancellation invalidates pending decisions',async()=>{
    let ticket=await create(vpItem),old=decisions(ticket)[0]!;
    ticket=await requests.decide(manager,old.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Approved'});expect(ticket.state).toBe('Open');
    ticket=await requests.change(agent,ticket.id,{revision:ticket.revision,reason:'Additional licences needed',itemId:vpItem.id,requestedForId:recipient.id,quantity:3});
    expect(ticket.state).toBe('Pending Approval');expect(ticket.approvals.find(a=>a.id===old.id)?.status).toBe('Invalidated');
    await expect(requests.decide(manager,old.id,{revision:ticket.revision,version:old.version,decision:'Approved'})).rejects.toThrow('changed');
    old=decisions(ticket)[0]!;
    const concurrency=await Promise.allSettled([requests.decide(manager,old.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Approved'}),requests.decide(manager,old.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Approved'})]);expect(concurrency.filter(v=>v.status==='fulfilled')).toHaveLength(1);
    const cancelled=await create();await tickets.state(employee,cancelled.id,{revision:cancelled.revision,state:'Cancelled',reason:'No longer required'});
    await expect(requests.decide(manager,decisions(cancelled)[0]!.id,{revision:cancelled.revision,version:cancelled.approvalVersion,decision:'Approved'})).rejects.toThrow();
    expect(await owner.approval.count({where:{tenantId,ticketId:cancelled.id,status:'Pending'}})).toBe(0);
  });
  it('rejection requires a public reason and terminal state forbids messages and fulfilment',async()=>{
    let ticket=await create();const approval=decisions(ticket)[0]!;
    expect(()=>requests.decide(manager,approval.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Rejected'})).toThrow('Rejection requires');
    ticket=await requests.decide(manager,approval.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Rejected',comment:'Budget is unavailable'});
    expect(ticket.state).toBe('Rejected');expect((await tickets.get(recipient,ticket.id)).activities.some(a=>a.body==='Budget is unavailable')).toBe(true);
    await expect(tickets.message(employee,ticket.id,{revision:ticket.revision,body:'Cannot post',audience:'customer'})).rejects.toThrow();
    await expect(tickets.state(agent,ticket.id,{revision:ticket.revision,state:'In Progress'})).rejects.toThrow();
  });
  it('dated delegation rejects cross-tenant, expired, ineligible and chained nominees and records original and actual actor',async()=>{
    const period={startsAt:new Date(Date.now()-1000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString()};
    await expect(requests.delegate(manager,{...period,delegateId:foreignUserId})).rejects.toThrow('same-organisation');
    await expect(requests.delegate(manager,{...period,delegateId:employee.id})).rejects.toThrow('eligible');
    await expect(requests.delegate(manager,{delegateId:delegate.id,startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()-1000).toISOString()})).rejects.toThrow('future');
    const delegation=await requests.delegate(manager,{...period,delegateId:delegate.id});
    await expect(requests.delegate(delegate,{...period,delegateId:vp.id})).rejects.toThrow('chains');
    const ticket=await create();const result=await requests.decide(delegate,decisions(ticket)[0]!.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Approved'});
    expect(decisions(result)[0]).toMatchObject({approverId:manager.id,decidedById:delegate.id});
    const forSelf=await create(approved,delegate);await expect(requests.decide(delegate,decisions(forSelf)[0]!.id,{revision:forSelf.revision,version:forSelf.approvalVersion,decision:'Approved'})).rejects.toThrow('not found');
    await requests.revoke(manager,delegation.id,{revision:delegation.revision});
    const revoked=await create();await expect(requests.decide(delegate,decisions(revoked)[0]!.id,{revision:revoked.revision,version:revoked.approvalVersion,decision:'Approved'})).rejects.toThrow('not found');
  });
  it('holds resume on customer reply, triage validates priorities, category changes reroute while sensitivity survives transfers',async()=>{
    let ticket=await tickets.create(employee,{categoryId,summary:'Incident requiring hold',description:'Waiting for customer to provide further information'},randomUUID());
    await expect(tickets.state(agent,ticket.id,{revision:ticket.revision,state:'On Hold'})).rejects.toThrow('Hold reason');
    ticket=await tickets.state(agent,ticket.id,{revision:ticket.revision,state:'On Hold',holdReason:'Awaiting customer'});
    ticket=await tickets.message(employee,ticket.id,{revision:ticket.revision,audience:'customer',body:'Additional details supplied'});expect(ticket.state).toBe('Open');
    ticket=await tickets.manage(agent,ticket.id,{revision:ticket.revision,action:'triage',priority:'P2',severity:'S2',reason:'Business impact confirmed'});expect(ticket.untriaged).toBe(false);
    expect(await tickets.assignmentOptions(agent,ticket.id)).toMatchObject({canAssign:true,users:[{id:agent.id}]});
    await expect(tickets.manage(agent,ticket.id,{revision:ticket.revision,action:'assign',assignedToId:outsider.id,reason:'Invalid group member'})).rejects.toThrow('assigned group');
    ticket=await tickets.manage(agent,ticket.id,{revision:ticket.revision,action:'assign',assignedToId:agent.id,reason:'Queue owner assigns agent'});expect(ticket.assignedToId).toBe(agent.id);
    ticket=await tickets.manage(agent,ticket.id,{revision:ticket.revision,action:'assign',assignedToId:null,reason:'Queue owner unassigns for claim'});
    ticket=await tickets.claim(agent,ticket.id,{revision:ticket.revision});
    ticket=await tickets.manage(agent,ticket.id,{revision:ticket.revision,action:'category',categoryId:securityCategoryId,reason:'Security investigation required'});expect(ticket.departmentId).toBe(securityId);
    ticket=await tickets.manage(agent,ticket.id,{revision:ticket.revision,action:'transfer',departmentId:otherGroupId,reason:'Other queue assumes restricted ownership'});expect(ticket.assignedToId).toBeNull();
    await expect(tickets.get(agent,ticket.id)).rejects.toThrow('not found');
    expect((await tickets.list(agent,{search:ticket.number})).tickets).toHaveLength(0);
    expect((await tickets.get(outsider,ticket.id)).id).toBe(ticket.id);
    ticket=await tickets.manage(outsider,ticket.id,{revision:ticket.revision,action:'category',categoryId,reason:'Return category with restricted sensitivity preserved'});expect(ticket.departmentId).toBe(departmentId);
    await expect(tickets.get(outsider,ticket.id)).rejects.toThrow('not found');
  });
  it('tenant-aware foreign keys and RLS reject cross-company workflow records and absent context',async()=>{
    const ticket=await create();
    await expect(owner.approval.create({data:{tenantId,ticketId:ticket.id,version:99,stage:'manager',approverId:foreignUserId}})).rejects.toThrow();
    await expect(owner.approval.create({data:{tenantId,ticketId:ticket.id,version:99,stage:'manager',approverId:manager.id,status:'Rejected',decidedById:manager.id,decidedAt:new Date()}})).rejects.toThrow();
    await expect(owner.ticket.create({data:{tenantId,type:'request',sequence:999999,number:'SR-incomplete',summary:'Missing required cost',description:'A request cannot omit cost fields',categoryId,departmentId,callerId:employee.id,requestedForId:recipient.id,itemId:approved.id,priority:'P4',severity:'S3'}})).rejects.toThrow();
    expect(await db.approval.count()).toBe(0);expect(await db.catalogItem.count()).toBe(0);expect(await db.approvalDelegation.count()).toBe(0);
    await expect(db.approvalDelegation.create({data:{tenantId,approverId:manager.id,delegateId:delegate.id,startsAt:new Date(),endsAt:new Date(Date.now()+10000)}})).rejects.toThrow();
    await db.withTenant(tenantId,async tx=>{expect(await tx.catalogItem.count()).toBeGreaterThan(0);});expect(await db.catalogItem.count()).toBe(0);
  });
  it('catalog policy edits and live manager drift invalidate stale approvals before decisions or fulfilment',async()=>{
    const config={name:'Mutable policy',categoryId,unitCostMinor:1000,currency:'AUD',requiresManager:true,requiresVp:false,vpThresholdMinor:null,vpApproverId:vp.id,alternateApproverId:null};
    const item=await requests.item(admin,config);let ticket=await create(item);
    await expect(requests.item(admin,{...config,currency:'USD',revision:item.revision},item.id)).rejects.toThrow('Currency and recurring');
    ticket=await requests.decide(manager,decisions(ticket)[0]!.id,{revision:ticket.revision,version:ticket.approvalVersion,decision:'Approved'});expect(ticket.state).toBe('Open');
    await requests.item(admin,{...config,revision:item.revision,requiresVp:true},item.id);
    const revised=await tickets.get(employee,ticket.id);expect(revised.state).toBe('Pending Approval');expect(revised.approvalVersion).toBe(ticket.approvalVersion+1);expect(decisions(revised).map(a=>a.stage)).toEqual(['manager','vp']);
    let drifted=await create(approved);const oldApproval=decisions(drifted)[0]!;
    await owner.user.update({where:{id:recipient.id},data:{managerId:delegate.id}});
    await expect(tickets.get(manager,drifted.id)).rejects.toThrow('not found');
    await expect(requests.decide(manager,oldApproval.id,{revision:drifted.revision,version:drifted.approvalVersion,decision:'Approved'})).rejects.toThrow('re-evaluated');
    drifted=await tickets.get(employee,drifted.id);expect(decisions(drifted)[0]!.approverId).toBe(delegate.id);
    drifted=await requests.decide(delegate,decisions(drifted)[0]!.id,{revision:drifted.revision,version:drifted.approvalVersion,decision:'Approved'});
    await owner.user.update({where:{id:recipient.id},data:{managerId:manager.id}});
    await expect(tickets.state(agent,drifted.id,{revision:drifted.revision,state:'In Progress'})).rejects.toThrow('re-evaluated');
    expect((await tickets.get(employee,drifted.id)).state).toBe('Pending Approval');
  });
  it('revalidates revoked sessions after the authentication guard and before tenant mutations',async()=>{
    const session=await owner.session.create({data:{tenantId,userId:employee.id,tokenHash:randomUUID(),csrfToken:'test',expiresAt:new Date(Date.now()+3600000)}});
    const authenticated={...employee,sessionId:session.id};await owner.session.delete({where:{id:session.id}});
    await expect(create(normal,authenticated)).rejects.toThrow('Session expired');
  });
  it('records assisted incident caller and submitter separately, forbids employee impersonation and tenant-mismatched callers',async()=>{
    const payload={categoryId,summary:'Recorded for another caller',description:'An agent records a telephone incident for an employee'};
    await expect(tickets.create(employee,{...payload,callerId:recipient.id},randomUUID())).rejects.toThrow('Only support agents');
    await expect(tickets.create(agent,{...payload,callerId:foreignUserId},randomUUID())).rejects.toThrow('active caller');
    await expect(tickets.create(employee,{...payload,channel:'Phone'},randomUUID())).rejects.toThrow('assisted channels');
    await expect(create(normal,employee,{channel:'Email'})).rejects.toThrow('assisted channels');
    await expect(tickets.create(agent,{...payload,channel:'Fax'},randomUUID())).rejects.toThrow();
    let ticket=await tickets.create(agent,{...payload,callerId:recipient.id,channel:'Phone'},randomUUID());
    expect(ticket).toMatchObject({callerId:recipient.id,submittedById:agent.id,submittedByName:'Agent',channel:'Phone',duplicateOfId:null});
    expect((await tickets.get(recipient,ticket.id)).id).toBe(ticket.id);
    await expect(tickets.get(employee,ticket.id)).rejects.toThrow('not found');
    expect((await owner.audit.findFirstOrThrow({where:{tenantId,ticketId:ticket.id,action:'incident.created'}})).actorId).toBe(agent.id);
    ticket=await tickets.manage(agent,ticket.id,{revision:ticket.revision,action:'category',categoryId:securityCategoryId,reason:'Sensitive caller investigation'});
    ticket=await tickets.message(agent,ticket.id,{revision:ticket.revision,audience:'internal',body:'Restricted staff evidence'});
    ticket=await tickets.manage(agent,ticket.id,{revision:ticket.revision,action:'transfer',departmentId:otherGroupId,reason:'Destination owns investigation'});
    const submitterView=await tickets.get(agent,ticket.id);expect(submitterView.id).toBe(ticket.id);expect(submitterView.activities.some(a=>a.body==='Restricted staff evidence')).toBe(false);
    expect((await tickets.list(agent,{scope:'mine',search:ticket.number})).tickets.some(t=>t.id===ticket.id)).toBe(true);
    const request=await create(normal,agent,{channel:'Walk In'});expect(request).toMatchObject({submittedById:agent.id,channel:'Walk In'});
    await expect(owner.ticket.update({where:{id:ticket.id},data:{submittedById:foreignUserId}})).rejects.toThrow();
  });
  it('filters category, assisted channel and assignee and searches only authorized caller/requested-for names',async()=>{
    let ticket=await tickets.create(agent,{categoryId,callerId:recipient.id,channel:'Email',summary:'Find by affected employee',description:'Search caller and requested-for names in authorized tickets'},randomUUID());
    ticket=await tickets.claim(agent,ticket.id,{revision:ticket.revision});
    expect((await tickets.list(agent,{categoryId,channel:'Email',assignedToId:agent.id,search:'Recipient'})).tickets.some(t=>t.id===ticket.id)).toBe(true);
    expect((await tickets.list(employee,{categoryId,channel:'Email',assignedToId:agent.id,search:'Recipient'})).tickets.some(t=>t.id===ticket.id)).toBe(false);
    expect((await tickets.list(foreignAuth,{search:'Recipient'})).tickets).toHaveLength(0);
    expect((await tickets.catalog(agent)).agents).toEqual([{id:agent.id,name:'Agent'}]);
    expect((await tickets.catalog(employee)).agents).toEqual([]);
    await expect(tickets.list(agent,{assigned:'me',assignedToId:agent.id})).rejects.toThrow('Choose either');
  });
});
