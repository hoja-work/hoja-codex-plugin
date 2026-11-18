/**
 * Adapter-side publication polish, applied through the same Hoja client Trebol's hoja-mode uses.
 *
 * Trebol's `extensions/hoja-mode/publish.ts` composes the issue description from the create operation's `description`
 * and never sends a priority: `HojaClient.createIssue` has no priority parameter, so `IssueCreateInput.priority` is
 * never populated and every published issue lands with Hoja's default. That is upstream behaviour — the vendored
 * files cannot be edited (hash-checked) — so the two writes below are added around the create call:
 *
 *   - the task's own description is put at the head of the issue body when the composed body does not already carry
 *     it (a create operation that omitted `description` left an issue with nothing but the managed block);
 *   - the task's priority (TaskManage defaults it to `medium`) is written with one `issueUpdate` after the create.
 *
 * Only the create request is touched. Trebol's lifecycle pass proves each description write by exact read-back
 * (`description_unverified`), so rewriting *those* writes would break it: a description added to a task after its
 * issue was created still stays local, exactly as in Trebol. Documented in the README parity section.
 */
import type { Task } from "../vendor/trebol/packages/tools/taskmanage/src/task-manage.ts";

/** The marker lines `publish.ts` writes; both name the TaskManage task the issue belongs to. */
const TRACKED_BY = /Tracked by TaskManage task #([^\s]+) in session/;
const LINK_MARKER = /Link marker: hoja-task:[^:\s]+:([A-Za-z0-9_-]+)/;
export const taskIdOfDescription = (description: string): string | undefined =>
	TRACKED_BY.exec(description)?.[1] ?? LINK_MARKER.exec(description)?.[1];

/** Hoja/Linear priorities are integers: 0 none, 1 urgent, 2 high, 3 medium, 4 low. TaskManage has no "urgent". */
export const PRIORITY_VALUES: Readonly<Record<string, number>> = { urgent: 1, high: 2, medium: 3, low: 4 };
export const priorityValue = (priority: unknown): number | undefined =>
	typeof priority === "string" ? PRIORITY_VALUES[priority.trim().toLowerCase()] : undefined;

/** Prepends the task's description when the composed body has none (never duplicates it). */
export const withTaskDescription = (description: string, taskDescription?: string): string => {
	const body = (taskDescription ?? "").trim();
	if (!body || description.includes(body)) return description;
	return `${body}\n\n${description}`;
};

const PRIORITY_MUTATION = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;

/** Best effort by design: an issue that exists must never be reported as failed because its priority write did not. */
export async function writePriority(client: unknown, issueId: unknown, priority: number | undefined, log?: (line: string) => void): Promise<boolean> {
	const c = client as { gql?: (query: string, variables?: unknown) => Promise<any> };
	if (!issueId || typeof issueId !== "string" || priority === undefined || typeof c?.gql !== "function") return false;
	try {
		const data = await c.gql(PRIORITY_MUTATION, { id: issueId, input: { priority } });
		if (!data?.issueUpdate?.success) { log?.(`priority ${priority} for ${issueId} was not confirmed`); return false; }
		return true;
	} catch (error) {
		log?.(`priority ${priority} for ${issueId} failed: ${(error as Error).message}`);
		return false;
	}
}

type TaskLike = Pick<Task, "id"> & Partial<Pick<Task, "description" | "priority">>;

/**
 * Wrap the Hoja client so `createIssue` carries the task's description and priority. Every other member is delegated
 * unchanged (bound to the real client, so private fields keep working).
 */
export function wrapHojaWriter<T extends object>(client: T, tasks: () => readonly TaskLike[], log?: (line: string) => void): T {
	if (!client || typeof (client as any).createIssue !== "function") return client;
	const taskFor = (description: string): TaskLike | undefined => {
		const id = taskIdOfDescription(String(description ?? ""));
		if (!id) return undefined;
		try { return tasks().find(task => String(task?.id) === id); } catch { return undefined; }
	};
	const createIssue = async (resolved: any, title: string, description: string, state?: string, options?: unknown) => {
		const task = taskFor(description);
		const body = withTaskDescription(String(description ?? ""), typeof task?.description === "string" ? task.description : undefined);
		const created = await (client as any).createIssue(resolved, title, body, state, options);
		await writePriority(client, created?.id, priorityValue(task?.priority), log);
		return created;
	};
	return new Proxy(client, {
		get(target, property) {
			if (property === "createIssue") return createIssue;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as T;
}
