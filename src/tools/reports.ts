import * as z from 'zod';
import { reportView, shareLinkView } from '../projections.js';
import { failure, refusal, success } from '../result.js';
import type { components } from '../v1.js';
import { projectId, reportId } from './schemas.js';
import { defineTool } from './types.js';

type S = components['schemas'];

export const createReport = defineTool({
  name: 'create_report',
  title: 'Build a client report',
  description: 'Builds a PDF or XLSX report of a project, branded for the agency. Building takes a moment: then call get_report.',
  operations: ['createReport'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: z.object({ project_id: projectId, format: z.enum(['pdf', 'xlsx']) }),
  async run(args, { api }) {
    const result = await api.request<S['Report']>({
      method: 'POST',
      path: `/projects/${args.project_id}/reports`,
      json: { format: args.format },
      idempotent: true,
    });
    if (!result.ok) return failure(result.error);
    return success({ report: reportView(result.data), next: 'Call get_report in a few seconds.' });
  },
});

export const getReport = defineTool({
  name: 'get_report',
  title: 'Read a report',
  description: 'Whether a report is ready, and how to get the file.',
  operations: ['getReport', 'getShareLink'],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  input: z.object({ report_id: reportId }),
  async run(args, { api, mode, transport }) {
    const result = await api.request<S['Report']>({ method: 'GET', path: `/reports/${args.report_id}` });
    if (!result.ok) return failure(result.error);
    const report = result.data;
    if (report.status !== 'ready') return success({ report: reportView(report) });
    if (transport === 'stdio') return success({ report: reportView(report), next: 'save_report_file saves it to disk.' });
    // The file needs the API key, so the remote server cannot hand it over.
    // A live project's client page lists its latest reports.
    if (mode === 'live') {
      const link = await api.request<S['ShareLink']>({ method: 'GET', path: `/projects/${report.project}/share_link` });
      if (link.ok && !link.data.revoked_at) {
        return success({ report: reportView(report), client_page: shareLinkView(link.data).url, next: 'The client page lists the latest reports.' });
      }
    }
    return success({
      report: reportView(report),
      next: 'Download it from the agency console, or with the local (npx) server, whose save_report_file saves it to disk.',
    });
  },
});

export const saveReportFile = defineTool({
  name: 'save_report_file',
  title: 'Save a report file',
  description: 'Downloads a ready report and saves it to a local folder (Downloads by default). Never overwrites a file. Returns the path.',
  operations: ['downloadReportFile'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  transports: ['stdio'],
  input: z.object({
    report_id: reportId,
    directory: z.string().max(4096).optional().describe('Folder to save into; Downloads by default'),
  }),
  async run(args, { api, files }) {
    if (!files) return refusal('Saving files works only with the local (npx) server.');
    const report = await api.request<S['Report']>({ method: 'GET', path: `/reports/${args.report_id}` });
    if (!report.ok) return failure(report.error);
    if (report.data.status !== 'ready') return refusal(`The report is ${report.data.status}, not ready yet.`);
    // Logins hold the directory passwords: they never pass through here.
    if (report.data.include_logins) return refusal('This report includes logins: download it from the agency console instead.');
    const download = await api.download(`/reports/${args.report_id}/file`);
    if (!download.ok) return failure(download.error);
    // The extension always says what the file is.
    const stem = (report.data.file_name ?? download.fileName ?? args.report_id).replace(/\.[^.]*$/, '');
    const name = `${stem}.${report.data.format}`;
    try {
      const saved = await files.write(args.directory, name, download.bytes);
      return success({ saved: saved.path, bytes: saved.size });
    } catch (error) {
      return refusal(error instanceof Error ? error.message : 'Could not save the file.');
    }
  },
});
