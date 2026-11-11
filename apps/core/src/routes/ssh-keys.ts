import {
  type ProjectSshKeyResponse,
  RemoveHostKeyRequest,
  SetSshKeyChoiceRequest,
  type SshKeyResponse,
  TrustHostKeyRequest,
  type TrustedHostKeysResponse,
  type TrustedHostKey,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { projects } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { listTrustedHostKeys, removeHostKey, sshFingerprint, trustHostKey } from '../ssh-keys/known-hosts.js';
import { deleteKey, generateKey, getPublicKey } from '../ssh-keys/store.js';

/** Emberline's shared SSH key, each project's key and choice, and the host keys a person trusted. */
export function registerSshKeyRoutes(app: FastifyInstance, db: Db): void {
  const project = (id: string) => {
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw notFound('no such project');
    return row;
  };
  const projectState = (id: string): ProjectSshKeyResponse => {
    const row = project(id);
    return {
      choice: row.sshKeyChoice,
      key: getPublicKey(db, { projectId: row.id }),
      shared: getPublicKey(db, 'shared'),
    };
  };

  app.get('/api/ssh-key', async (): Promise<SshKeyResponse> => ({ key: getPublicKey(db, 'shared') }));
  app.post('/api/ssh-key', async (): Promise<SshKeyResponse> => ({ key: generateKey(db, 'shared') }));
  app.delete('/api/ssh-key', async (_request, reply) => {
    deleteKey(db, 'shared');
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/ssh-key', async (request) =>
    projectState(request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/projects/:id/ssh-key', async (request) => {
    const row = project(request.params.id);
    generateKey(db, { projectId: row.id, slug: row.slug });
    return projectState(row.id);
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id/ssh-key', async (request, reply) => {
    deleteKey(db, { projectId: project(request.params.id).id });
    return reply.code(204).send();
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/ssh-key-choice', async (request) => {
    const { choice } = SetSshKeyChoiceRequest.parse(request.body);
    const row = project(request.params.id);
    if (choice === 'own' && !getPublicKey(db, { projectId: row.id })) {
      generateKey(db, { projectId: row.id, slug: row.slug });
    }
    db.update(projects).set({ sshKeyChoice: choice }).where(eq(projects.id, row.id)).run();
    return projectState(row.id);
  });

  app.get('/api/ssh-host-keys', async (): Promise<TrustedHostKeysResponse> => ({
    hosts: listTrustedHostKeys(db),
  }));
  app.post('/api/ssh-host-keys', async (request, reply): Promise<TrustedHostKey> => {
    const body = TrustHostKeyRequest.parse(request.body);
    if (sshFingerprint(body.key) !== body.fingerprint) {
      throw badRequest('the fingerprint does not match the host key');
    }
    const stored = trustHostKey(db, body);
    reply.code(201);
    return stored;
  });
  app.delete('/api/ssh-host-keys', async (request, reply) => {
    const body = RemoveHostKeyRequest.parse(request.body);
    removeHostKey(db, body.host, body.port, body.keyType);
    return reply.code(204).send();
  });
}
