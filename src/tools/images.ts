import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { ApiRequest } from '../client.js';
import { imageView } from '../projections.js';
import { failure, refusal, success } from '../result.js';
import type { components } from '../v1.js';
import { imageId, projectId } from './schemas.js';
import { defineTool, type ToolContext, type Transport } from './types.js';

type S = components['schemas'];

const imageUrl = z.string().max(2048).describe('Public image URL: PNG, JPEG, GIF or WebP, 5 MB at most');

// A local file only on stdio, where the server runs on the user's machine:
// it spares the model from uploading a client's assets somewhere public first.
function imageInput(transport: Transport) {
  return transport === 'stdio'
    ? z.object({
        project_id: projectId,
        url: imageUrl.optional(),
        file_path: z.string().max(4096).optional().describe('A local image inside SUBMITATOR_FILES_DIR (or the starting folder), instead of url'),
      })
    : z.object({ project_id: projectId, url: imageUrl });
}

type ImageArgs = { project_id: string; url?: string; file_path?: string };

async function imagePayload(
  args: ImageArgs,
  context: ToolContext,
  role: 'logo' | 'screenshot',
): Promise<{ ok: true; body: Pick<ApiRequest, 'json' | 'form'> } | { ok: false; result: CallToolResult }> {
  const hasUrl = typeof args.url === 'string' && args.url !== '';
  const hasFile = typeof args.file_path === 'string' && args.file_path !== '';
  if (hasUrl === hasFile) return { ok: false, result: refusal('Send exactly one of url or file_path.') };
  if (hasUrl) return { ok: true, body: { json: { url: args.url } } };
  if (!context.files) return { ok: false, result: refusal('file_path works only with the local (npx) server. Send a public image URL instead.') };
  try {
    const file = await context.files.read(args.file_path as string);
    const form = new FormData();
    // A neutral name: the local one often carries a person's name.
    form.append('file', new Blob([file.bytes], { type: file.type }), `${role}.${file.extension}`);
    return { ok: true, body: { form } };
  } catch (error) {
    return { ok: false, result: refusal(error instanceof Error ? error.message : 'Could not read the file.') };
  }
}

function imagesOf(project: S['Project']) {
  return {
    project: project.id,
    logo: imageView(project.logo),
    screenshots: project.screenshots?.map((image) => imageView(image)),
    missing: project.readiness?.missing,
  };
}

export const setLogo = defineTool({
  name: 'set_logo',
  title: 'Set the logo',
  description: (transport) =>
    transport === 'stdio'
      ? "Sets or replaces a project's logo. A URL is fetched right away (a failed fetch answers image_unreachable); with the npx package a local file inside SUBMITATOR_FILES_DIR (or the folder the server started in) works too."
      : "Sets or replaces a project's logo from a public image URL, fetched right away (a failed fetch answers image_unreachable).",
  operations: ['setProjectLogo'],
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  input: imageInput,
  async run(args, context) {
    const payload = await imagePayload(args as ImageArgs, context, 'logo');
    if (!payload.ok) return payload.result;
    const result = await context.api.request<S['Project']>({ method: 'PUT', path: `/projects/${args.project_id}/logo`, ...payload.body });
    if (!result.ok) return failure(result.error);
    return success(imagesOf(result.data));
  },
});

export const addScreenshot = defineTool({
  name: 'add_screenshot',
  title: 'Add a screenshot',
  description: (transport) =>
    transport === 'stdio'
      ? 'Adds one screenshot to a project (5 at most), from a public URL or, with the npx package, a local file. Each call adds another one, so do not repeat a call that succeeded.'
      : 'Adds one screenshot to a project (5 at most), from a public image URL. Each call adds another one, so do not repeat a call that succeeded.',
  operations: ['addProjectScreenshot'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: imageInput,
  async run(args, context) {
    const payload = await imagePayload(args as ImageArgs, context, 'screenshot');
    if (!payload.ok) return payload.result;
    const result = await context.api.request<S['Project']>({ method: 'POST', path: `/projects/${args.project_id}/screenshots`, ...payload.body });
    if (!result.ok) return failure(result.error);
    return success(imagesOf(result.data));
  },
});

export const removeImage = defineTool({
  name: 'remove_image',
  title: 'Remove the logo or a screenshot',
  description: 'Removes the logo ("logo") or one screenshot (its img_ id). A launched project keeps at least its logo and one screenshot.',
  operations: ['deleteProjectLogo', 'deleteProjectScreenshot'],
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    project_id: projectId,
    image: z.union([z.literal('logo'), imageId]).describe('"logo", or the img_ id of a screenshot'),
  }),
  async run(args, { api }) {
    const path =
      args.image === 'logo' ? `/projects/${args.project_id}/logo` : `/projects/${args.project_id}/screenshots/${args.image}`;
    const result = await api.request<S['Project']>({ method: 'DELETE', path });
    if (!result.ok) return failure(result.error);
    return success(imagesOf(result.data));
  },
});
