import { describe, expect, it } from 'vitest';
import { createOpenApiDocument } from '../src/openapi.js';

describe('public OpenAPI generated from shared Zod contracts',()=>{
  it('generates serializable schemas, route references, mutation security and multipart metadata',()=>{
    const document=createOpenApiDocument();expect(document.openapi).toBe('3.1.0');expect(Object.keys(document.paths).length).toBeGreaterThan(40);
    expect(document.components.schemas.createTicketSchema?.properties?.summary).toMatchObject({type:'string',minLength:5,maxLength:160});
    expect(document.components.schemas.createUserSchema?.properties?.email).toMatchObject({type:'string',format:'email'});
    const create=document.paths['/tickets']!.post as {security:unknown;requestBody:unknown};expect(create.security).toEqual([{sessionCookie:[],csrfToken:[]}]);expect(create.requestBody).toMatchObject({content:{'application/json':{schema:{$ref:'#/components/schemas/createTicketSchema'}}}});
    expect(document.paths['/openapi.json']!.get).toMatchObject({security:[]});
    expect(document.paths['/tickets/{id}/attachments']!.post).toMatchObject({requestBody:{content:{'multipart/form-data':{schema:{required:['file','revision','audience']}}}}});
    const json=JSON.stringify(document);for(const match of json.matchAll(/#\/components\/schemas\/(\w+)/g))expect(document.components.schemas).toHaveProperty(match[1]!);
    expect(JSON.parse(json).paths['/approvals/{id}/decision']).toBeDefined();
  });
});
