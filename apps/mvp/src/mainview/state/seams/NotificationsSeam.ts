/*
 * The notifications seam: GET /api/notifications/list and
 * PUT /api/notifications/mark-read. Reference: multi
 * src/smithersCloud/notifications.ts.
 */
import type { Card } from "../AppState";
import type { SeamContext } from "./SeamContext";
import { readErrorMessage } from "./SeamContext";

export interface NotificationsSeam {
	readonly listNotifications: () => Promise<string | void>;
	readonly markNotificationsRead: () => Promise<string | void>;
}

/** One page is plenty for a transcript card; the platform caps pages anyway. */
const LIST_LIMIT = 20;

type NotificationItem = Extract<Card, { kind: "notifications" }>["payload"]["items"][number];

/*
 * One wire notification, GitHub-shaped (reference parseNotification): id +
 * subject.title are required, everything else degrades to null. `unread`
 * defaults true when absent, so `read` is only ever the explicit `false`.
 */
const parseNotification = (value: unknown): NotificationItem | null => {
	if (value === null || typeof value !== "object") return null;
	const wire = value as Record<string, unknown>;
	const id = wire.id;
	if (typeof id !== "string" && typeof id !== "number") return null;
	const subject = wire.subject;
	const title =
		subject !== null && typeof subject === "object" && typeof (subject as { title?: unknown }).title === "string"
			? (subject as { title: string }).title
			: null;
	if (title === null) return null;
	const repository = wire.repository;
	const repo =
		repository !== null &&
		typeof repository === "object" &&
		typeof (repository as { full_name?: unknown }).full_name === "string" &&
		(repository as { full_name: string }).full_name !== ""
			? (repository as { full_name: string }).full_name
			: null;
	return {
		id: String(id),
		title,
		repo,
		reason: typeof wire.reason === "string" ? wire.reason : null,
		createdAt: typeof wire.updated_at === "string" ? wire.updated_at : null,
		read: wire.unread === false,
	};
};

/** The list body is a bare array (reference parseNotificationListBody); off-shape rows drop. */
const parseNotificationList = (body: unknown): NotificationItem[] => {
	const items: NotificationItem[] = [];
	for (const value of Array.isArray(body) ? body : []) {
		const item = parseNotification(value);
		if (item !== null) items.push(item);
	}
	return items;
};

export const createNotificationsSeam = (ctx: SeamContext): NotificationsSeam => {
	const listNotifications = async (): Promise<string | void> => {
		// The reference's query params: `all` includes read rows (the card shows
		// both and counts the unread), `limit` bounds the page.
		const query = new URLSearchParams();
		query.set("limit", String(LIST_LIMIT));
		query.set("all", "true");
		let response: Response;
		try {
			response = await ctx.http(`${ctx.baseUrl}/api/notifications/list?${query.toString()}`);
		} catch {
			return "Your notifications couldn't be loaded — the platform didn't answer.";
		}
		if (!response.ok) {
			return readErrorMessage(response, "Your notifications couldn't be loaded right now.");
		}
		const body = (await response.json().catch(() => undefined)) as unknown;
		const items = parseNotificationList(body);
		const card: Card = {
			id: "notifications",
			kind: "notifications",
			title: "Notifications",
			status: "active",
			createdAt: Date.now(),
			ordinal: ctx.nextOrdinal(),
			payload: {
				unread: items.filter((item) => !item.read).length,
				items,
			},
		};
		ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card });
	};

	const markNotificationsRead = async (): Promise<string | void> => {
		let response: Response;
		try {
			response = await ctx.http(`${ctx.baseUrl}/api/notifications/mark-read`, { method: "PUT" });
		} catch {
			return "Your notifications couldn't be marked read — the platform didn't answer.";
		}
		// The platform answers 205 on success (reference markAllNotificationsRead).
		if (response.status !== 205 && !response.ok) {
			return readErrorMessage(response, "Your notifications couldn't be marked read right now.");
		}
		// Re-fetch so the card states the platform's answer, not our assumption.
		return listNotifications();
	};

	return { listNotifications, markNotificationsRead };
};
