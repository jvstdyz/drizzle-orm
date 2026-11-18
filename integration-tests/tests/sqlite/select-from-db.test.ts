import Database from 'better-sqlite3';
import { relations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { customType, integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { beforeAll, describe, expect, test } from 'vitest';

// Stored lowercase, wrapped in `upper(...)` on select, decoded back to lowercase
// by `fromDriver`: a full round trip through the wrap.
const lowerText = customType<{ data: string; driverData: string }>({
	dataType: () => 'text',
	fromDriver: (value) => value.toLowerCase(),
	selectFromDb: (column) => sql`upper(${column})`,
});

// Wrapped in `upper(...)` on select with no `fromDriver` decoding, so a wrapped
// read is directly observable: stored 'hello' reads back as 'HELLO'.
const shoutText = customType<{ data: string; driverData: string }>({
	dataType: () => 'text',
	selectFromDb: (column) => sql`upper(${column})`,
});

const users = sqliteTable('users', {
	id: integer('id').primaryKey(),
	name: lowerText('name').notNull(),
});

const posts = sqliteTable('posts', {
	id: integer('id').primaryKey(),
	title: shoutText('title').notNull(),
	authorId: integer('author_id'),
});

const usersRelations = relations(users, ({ many }) => ({
	posts: many(posts),
}));

const postsRelations = relations(posts, ({ one }) => ({
	author: one(users, {
		fields: [posts.authorId],
		references: [users.id],
	}),
}));

const client = new Database(':memory:');
const db = drizzle(client, { schema: { users, posts, usersRelations, postsRelations } });

beforeAll(() => {
	client.exec(`
		create table users (id integer primary key, name text not null);
		create table posts (id integer primary key, title text not null, author_id integer);
	`);
});

describe('selectFromDb with better-sqlite3', () => {
	test('core select applies the wrap and decodes through fromDriver', async () => {
		await db.insert(users).values({ id: 1, name: 'alice' });

		// the stored value is untouched: the wrap happens on read, not on write
		const raw = client.prepare('select name from users where id = 1').get() as { name: string };
		expect(raw.name).toBe('alice');

		const result = await db.select().from(users);
		expect(result).toEqual([{ id: 1, name: 'alice' }]);
	});

	test('the wrap is observable without fromDriver decoding', async () => {
		await db.insert(posts).values({ id: 10, title: 'hello', authorId: 1 });

		const result = await db.select().from(posts);
		expect(result).toEqual([{ id: 10, title: 'HELLO', authorId: 1 }]);
	});

	test('insert returning applies the wrap', async () => {
		const result = await db.insert(users).values({ id: 2, name: 'bob' }).returning();
		expect(result).toEqual([{ id: 2, name: 'bob' }]);
	});

	test('relational query with a nested relation applies the wrap', async () => {
		const result = await db.query.users.findMany({
			where: (users, { eq }) => eq(users.id, 1),
			with: { posts: true },
		});
		expect(result).toEqual([{
			id: 1,
			name: 'alice',
			posts: [{ id: 10, title: 'HELLO', authorId: 1 }],
		}]);
	});
});
