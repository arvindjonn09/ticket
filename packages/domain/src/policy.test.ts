import { describe, expect, it } from 'vitest';
import { approvalPlan, canActApproval, canClaimTicket, canConfigureOrganisation, canMessage, canReadTicket, canTransition, effectiveDepartment, eligibleApprover, routeCategory, type Actor, type Ticket } from './index.js';
const employee: Actor = { id: 'employee', tenantId: 'one', role: 'employee', departmentIds: [] };
const agent: Actor = { id: 'agent', tenantId: 'one', role: 'agent', departmentIds: ['it'] };
const ticket: Ticket = { tenantId: 'one', callerId: 'employee', departmentId: 'it', assignedToId: null, sensitive: false, state: 'Open' };
describe('incident policy', () => {
  it('requires verified admin for config, never grants admin ticket bypass, and inherits only null overrides', () => {
    const admin = { ...agent, role: 'admin' as const, mfaVerified: true };
    expect(canConfigureOrganisation(admin)).toBe(true);
    expect(canConfigureOrganisation({ ...admin, mfaVerified: false })).toBe(false);
    expect(canConfigureOrganisation({ ...agent, mfaVerified: true })).toBe(false);
    expect(canReadTicket(admin, ticket)).toBe(false);
    expect(canClaimTicket(admin, ticket)).toBe(false);
    expect(effectiveDepartment('base', null)).toBe('base');
    expect(effectiveDepartment('base', 'override')).toBe('override');
  });
  it('denies another tenant and other employees on every action', () => {
    for (const actor of [{ ...employee, tenantId: 'two' }, { ...employee, id: 'other' }]) {
      expect(canReadTicket(actor, ticket)).toBe(false);
      expect(canClaimTicket(actor, ticket)).toBe(false);
      expect(canMessage(actor, ticket, 'customer')).toBe(false);
      expect(canTransition(actor, ticket, 'In Progress')).toBe(false);
    }
  });
  it('restricts sensitive content and all staff actions to its assigned group', () => {
    const outsider = { ...agent, departmentIds: ['other'] };
    expect(canReadTicket(outsider, ticket)).toBe(true);
    expect(canReadTicket(outsider, { ...ticket, sensitive: true })).toBe(false);
    expect(canClaimTicket(outsider, ticket)).toBe(false);
    expect(canMessage(outsider, ticket, 'internal')).toBe(false);
    expect(canMessage(employee, ticket, 'internal')).toBe(false);
  });
  it.each(['Complete', 'Cancelled','Rejected'])('forbids messages and claims on terminal %s', state => {
    expect(canMessage(employee, { ...ticket, state }, 'customer')).toBe(false);
    expect(canMessage(agent, { ...ticket, state }, 'internal')).toBe(false);
    expect(canClaimTicket(agent, { ...ticket, state })).toBe(false);
  });
  it('enforces supported transitions and requester confirmation', () => {
    expect(canTransition(agent, ticket, 'In Progress')).toBe(true);
    expect(canTransition(agent, ticket, 'Resolved')).toBe(false);
    expect(canTransition(employee, { ...ticket, state: 'Resolved' }, 'Complete')).toBe(true);
    expect(canTransition(agent, { ...ticket, state: 'Resolved' }, 'Complete')).toBe(false);
    expect(canClaimTicket(agent, { ...ticket, assignedToId: 'other' })).toBe(false);
  });
  it('preserves sensitivity during triage fallback', () => expect(routeCategory({ departmentId: 'it', sensitive: true }, false, 'triage')).toEqual({ departmentId: 'triage', sensitive: true, exception: true }));
  it('checks request recipients, stage thresholds, eligible direct delegates and expiry',()=>{
    const original={id:'manager',active:true,approverEligible:true,isVp:true},actual={...original,id:'delegate'},request={callerId:'employee',requestedForId:'recipient'},now=new Date('2026-11-10T00:00:00Z');
    expect(canReadTicket({...employee,id:'recipient'},{...ticket,requestedForId:'recipient'})).toBe(true);
    expect(approvalPlan({requiresManager:true,requiresVp:false,vpThresholdMinor:2000},1999)).toEqual({manager:true,vp:false});
    expect(approvalPlan({requiresManager:true,requiresVp:false,vpThresholdMinor:2000},2000)).toEqual({manager:true,vp:true});
    expect(eligibleApprover({...original,id:'recipient'},'employee','recipient',false)).toBe(false);
    const period={active:true,startsAt:new Date('2026-11-09T00:00:00Z'),endsAt:new Date('2026-11-11T00:00:00Z')};
    expect(canActApproval('delegate',original,actual,request,true,period,now)).toBe(true);
    expect(canActApproval('delegate',original,actual,request,true,{...period,endsAt:now},now)).toBe(false);
    expect(canActApproval('delegate',original,{...actual,isVp:false},request,true,period,now)).toBe(false);
    expect(canActApproval('delegate',original,{...actual,id:'employee'},request,true,period,now)).toBe(false);
  });
  it('keeps caller and submitter public access separate from sensitive group support access',()=>{
    const behalf={...ticket,callerId:'caller',submittedById:'employee',sensitive:true};
    expect(canReadTicket(employee,behalf)).toBe(true);
    expect(canMessage(employee,behalf,'customer')).toBe(true);
    expect(canMessage(employee,behalf,'internal')).toBe(false);
    expect(canReadTicket({...employee,id:'caller'},behalf)).toBe(true);
    expect(canReadTicket({...employee,id:'other'},behalf)).toBe(false);
    expect(canReadTicket({...employee,tenantId:'two'},behalf)).toBe(false);
  });
});
