import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import * as contracts from '@astrama/contracts';

type SchemaName=keyof typeof contracts;
type Route={method:'get'|'post';path:string;summary:string;body?:SchemaName;query?:SchemaName;response?:SchemaName;public?:boolean;idempotent?:boolean;upload?:boolean;download?:boolean};
const routes:Route[]=[
  {method:'get',path:'/health',summary:'API health',public:true},
  {method:'post',path:'/auth/forgot-password',summary:'Request a time-limited password reset; generic response',body:'forgotPasswordSchema',public:true},
  {method:'post',path:'/auth/reset-password',summary:'Consume a password reset; preserves enrolled MFA',body:'resetPasswordSchema',public:true},
  {method:'get',path:'/admin/automation',summary:'Read organisation business calendar and automation policy'},
  {method:'post',path:'/admin/automation',summary:'Save organisation business calendar and automation policy',body:'automationSettingsSchema'},
  {method:'get',path:'/admin/data-policy',summary:'Read attachment and retention policy'},
  {method:'post',path:'/admin/data-policy',summary:'Save attachment and retention policy',body:'dataPolicySchema'},
  {method:'get',path:'/admin/operations',summary:'Read component health; MFA administrator'},
  {method:'get',path:'/openapi.json',summary:'Public API contracts',public:true},
  {method:'post',path:'/auth/login',summary:'Sign in to an organisation',body:'loginSchema',response:'sessionViewSchema',public:true},
  {method:'post',path:'/auth/activate',summary:'Activate a time-limited account invitation',body:'invitationActivationSchema',public:true},
  {method:'get',path:'/auth/session',summary:'Read current session',response:'sessionViewSchema'},
  {method:'post',path:'/auth/logout',summary:'Revoke current session'},
  {method:'post',path:'/auth/password',summary:'Change own password',body:'passwordChangeSchema'},
  {method:'post',path:'/auth/mfa/setup',summary:'Start administrator authenticator enrolment'},
  {method:'post',path:'/auth/mfa/verify',summary:'Verify authenticator enrolment',body:'mfaVerifySchema',response:'sessionViewSchema'},
  {method:'get',path:'/catalog',summary:'Read applicable categories, routing and permitted agents'},
  {method:'get',path:'/tickets',summary:'List authorized tickets',query:'ticketQuerySchema'},
  {method:'post',path:'/tickets',summary:'Create an incident',body:'createTicketSchema',response:'ticketDetailSchema',idempotent:true},
  {method:'get',path:'/tickets/{id}',summary:'Read authorized ticket',response:'ticketDetailSchema'},
  {method:'post',path:'/tickets/{id}/claim',summary:'Claim ticket in own group',body:'revisionSchema',response:'ticketDetailSchema'},
  {method:'post',path:'/tickets/{id}/messages',summary:'Post a permitted customer message or internal note',body:'messageSchema',response:'ticketDetailSchema'},
  {method:'post',path:'/tickets/{id}/state',summary:'Transition ticket state',body:'stateSchema',response:'ticketDetailSchema'},
  {method:'post',path:'/tickets/{id}/manage',summary:'Triage, transfer, recategorize or assign ticket',body:'manageTicketSchema',response:'ticketDetailSchema'},
  {method:'get',path:'/tickets/{id}/assignment-options',summary:'Read active agents and assignment authority in recorded group'},
  {method:'get',path:'/tickets/{id}/history',summary:'Read permitted ticket audit history'},
  {method:'get',path:'/tickets/{id}/attachments',summary:'List permitted clean attachments'},
  {method:'post',path:'/tickets/{id}/attachments',summary:'Upload and scan an authorized attachment',upload:true},
  {method:'get',path:'/tickets/{id}/attachments/{attachmentId}/download',summary:'Download an authorized clean attachment',download:true},
  {method:'get',path:'/requests/catalog',summary:'Read active request items and requested-for options'},
  {method:'post',path:'/requests',summary:'Create a service request and evaluate approvals',body:'createRequestSchema',response:'ticketDetailSchema',idempotent:true},
  {method:'post',path:'/requests/{id}/change',summary:'Change material request details and invalidate approvals',body:'changeRequestSchema',response:'ticketDetailSchema'},
  {method:'post',path:'/requests/{id}/correct-approvals',summary:'Re-evaluate approvals after authorized directory or catalog correction',body:'correctionSchema'},
  {method:'get',path:'/approvals',summary:'List currently actionable approvals'},
  {method:'post',path:'/approvals/{id}/decision',summary:'Decide a current approval',body:'approvalDecisionSchema',response:'ticketDetailSchema'},
  {method:'get',path:'/approvals/delegations',summary:'List own delegations and eligible nominees'},
  {method:'post',path:'/approvals/delegations',summary:'Nominate a direct dated delegate',body:'delegationSchema'},
  {method:'post',path:'/approvals/delegations/{id}/revoke',summary:'Revoke own delegation',body:'revisionSchema'},
  {method:'get',path:'/admin/request-items',summary:'Read request item configuration; MFA administrator'},
  {method:'post',path:'/admin/request-items',summary:'Create request item; MFA administrator',body:'createRequestItemSchema'},
  {method:'post',path:'/admin/request-items/{id}',summary:'Update request item; MFA administrator',body:'updateRequestItemSchema'},
  {method:'get',path:'/admin/approval-corrections',summary:'Read correction metadata without confidential ticket content; MFA administrator'},
  {method:'get',path:'/admin/config',summary:'Read organisation routing configuration; MFA administrator'},
  {method:'post',path:'/admin/groups',summary:'Create support group; MFA administrator',body:'createGroupSchema'},
  {method:'post',path:'/admin/groups/{id}',summary:'Update support group; MFA administrator',body:'updateGroupSchema'},
  {method:'post',path:'/admin/categories',summary:'Create category; MFA administrator',body:'createCategorySchema'},
  {method:'post',path:'/admin/categories/{id}',summary:'Update category; MFA administrator',body:'updateCategorySchema'},
  {method:'post',path:'/admin/categories/{id}/delete',summary:'Archive a used category or delete an unused category; MFA administrator',body:'revisionSchema'},
  {method:'post',path:'/admin/subcategories',summary:'Create subcategory; MFA administrator',body:'createSubcategorySchema'},
  {method:'post',path:'/admin/subcategories/{id}',summary:'Update subcategory; MFA administrator',body:'updateSubcategorySchema'},
  {method:'post',path:'/admin/subcategories/{id}/delete',summary:'Archive a used subcategory or delete an unused subcategory; MFA administrator',body:'revisionSchema'},
  {method:'get',path:'/admin/users',summary:'List organisation accounts; MFA administrator'},
  {method:'post',path:'/admin/users',summary:'Create invited account; MFA administrator',body:'createUserSchema'},
  {method:'post',path:'/admin/users/{id}',summary:'Update account; MFA administrator',body:'updateUserSchema'},
  {method:'post',path:'/admin/users/{id}/invite',summary:'Replace inactive account invitation; MFA administrator',body:'revisionSchema'},
  {method:'post',path:'/admin/users/import/preview',summary:'Validate CSV account import; MFA administrator',body:'userImportSchema'},
  {method:'post',path:'/admin/users/import/commit',summary:'Commit the current validated CSV preview; MFA administrator',body:'userImportCommitSchema'},
  {method:'get',path:'/admin/settings',summary:'Read organisation settings; MFA administrator'},
  {method:'post',path:'/admin/settings',summary:'Update organisation settings; MFA administrator',body:'organisationSettingsSchema'},
  {method:'get',path:'/profile',summary:'Read own profile and permitted history'},
  {method:'get',path:'/users/{id}',summary:'Read permitted user profile and history'},
  {method:'get',path:'/reports/summary',summary:'Read authorization-filtered operational metrics',query:'ticketQuerySchema'},
  {method:'get',path:'/reports/export',summary:'Export and audit authorized staff CSV',query:'ticketQuerySchema',download:true},
  {method:'get',path:'/knowledge',summary:'Search internal resolutions in own support groups'}
];

export function createOpenApiDocument(){
  const schemas=Object.fromEntries(Object.entries(contracts).filter(([name,schema])=>name.endsWith('Schema')&&schema instanceof z.ZodType).map(([name,schema])=>[name,z.toJSONSchema(schema as z.ZodType,{io:'input',target:'draft-2020-12'})]));
  const reference=(name:SchemaName)=>({$ref:`#/components/schemas/${name}`});
  const paths:Record<string,Record<string,unknown>>={};
  for(const route of routes){
    const parameters:Record<string,unknown>[]=[...route.path.matchAll(/\{(\w+)\}/g)].map(match=>({name:match[1],in:'path',required:true,schema:{type:'string',format:'uuid'}}));
    if(route.query){const query=schemas[route.query]!;for(const[name,schema]of Object.entries(query.properties??{}))parameters.push({name,in:'query',required:query.required?.includes(name)??false,schema});}
    if(route.path==='/knowledge')parameters.push({name:'search',in:'query',required:true,schema:{type:'string',minLength:2,maxLength:160}});
    if(route.method==='post')parameters.push({name:'Origin',in:'header',required:true,description:'Must exactly match the configured application origin.',schema:{type:'string',format:'uri'}});
    if(route.idempotent)parameters.push({name:'Idempotency-Key',in:'header',required:true,description:'Actor- and operation-scoped; reuse only with identical request content.',schema:{type:'string',minLength:1,maxLength:128,pattern:'^[!-~]+$'}});
    const content=route.download?{[route.path.endsWith('/export')?'text/csv':'application/octet-stream']:{schema:{type:'string',format:'binary'}}}:{'application/json':{schema:route.response?reference(route.response):{type:'object',additionalProperties:true}}};
    const operation:Record<string,unknown>={summary:route.summary,parameters,security:route.public?[]:[route.method==='post'?{sessionCookie:[],csrfToken:[]}:{sessionCookie:[]}],responses:{[route.method==='post'?'201':'200']:{description:'Authorized operation succeeded. Responses without a shared Zod validator are documented generically.',content},'400':{description:'Invalid input or cross-field validation failed.'},'401':{description:'Session or sign-in required.'},'403':{description:'Role, MFA, group, origin, CSRF, or action is not permitted.'},'404':{description:'Record does not exist or is inaccessible.'},'409':{description:'Revision, idempotency, policy, or state conflict; refresh before retrying.'}}};
    if(route.body)operation.requestBody={required:true,content:{'application/json':{schema:reference(route.body)}}};
    if(route.upload)operation.requestBody={required:true,content:{'multipart/form-data':{schema:{type:'object',required:['file','revision','audience'],properties:{file:{type:'string',format:'binary',description:'One non-empty file, at most 5 MiB; scanned before publication.'},revision:{type:'integer',minimum:0},audience:{type:'string',enum:['customer','internal']}}}}}};
    paths[route.path]??={};paths[route.path]![route.method]=operation;
  }
  return {openapi:'3.1.0',info:{title:'Astrama API',version:'0.1.0',description:'Tenant-scoped session API. HTTP-only session cookies identify the actor; authenticated mutations require x-csrf-token and the exact application Origin. Administrator operations require verified MFA. Shared Zod schemas generate input contracts; server-side authorization, cross-field refinements, current revisions, approval eligibility and state rules also apply. This public document contains contract metadata only.'},servers:[{url:'/api'}],components:{securitySchemes:{sessionCookie:{type:'apiKey',in:'cookie',name:'astrama_session'},csrfToken:{type:'apiKey',in:'header',name:'x-csrf-token'}},schemas},paths};
}

@Controller()
export class ContractsController {
  @Get('openapi.json') document(){return createOpenApiDocument();}
}
