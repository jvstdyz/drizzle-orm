import { describe, expect, test } from 'vitest';

import { GelDialect } from '~/gel-core/dialect.ts';
import { customType as gelCustomType, gelTable, integer as gelInteger } from '~/gel-core/index.ts';
import { customType as mysqlCustomType, int as mysqlInt, mysqlTable, serial as mysqlSerial } from '~/mysql-core/index.ts';
import { drizzle as mysqlProxyDrizzle } from '~/mysql-proxy/index.ts';
import { PgDialect } from '~/pg-core/dialect.ts';
import { customType as pgCustomType, integer, pgTable, serial } from '~/pg-core/index.ts';
import { drizzle as pgProxyDrizzle } from '~/pg-proxy/index.ts';
import { relations } from '~/relations.ts';
import {
	customType as singlestoreCustomType,
	int as singlestoreInt,
	serial as singlestoreSerial,
	singlestoreTable,
} from '~/singlestore-core/index.ts';
import { drizzle as singlestoreProxyDrizzle } from '~/singlestore-proxy/index.ts';
import { sql } from '~/sql/sql.ts';
import { customType as sqliteCustomType, integer as sqliteInteger, sqliteTable } from '~/sqlite-core/index.ts';
import { drizzle as sqliteProxyDrizzle } from '~/sqlite-proxy/index.ts';

// A custom type whose values are stored lowercase. Reading a value back wraps the
// column in `upper(...)`, so the driver returns the uppercase form, and `fromDriver`
// converts it back to the lowercase application representation.
const pgUpperText = pgCustomType<{ data: string; driverData: string }>({
	dataType: () => 'text',
	fromDriver: (value) => value.toLowerCase(),
	selectFromDb: (column) => sql`upper(${column})`,
});

const pgUsers = pgTable('users', {
	id: serial('id').primaryKey(),
	name: pgUpperText('name').notNull(),
});

const pgPosts = pgTable('posts', {
	id: serial('id').primaryKey(),
	title: pgUpperText('title').notNull(),
	authorId: integer('author_id').references(() => pgUsers.id),
});

const pgUsersRelations = relations(pgUsers, ({ many }) => ({
	posts: many(pgPosts),
}));

const pgPostsRelations = relations(pgPosts, ({ one }) => ({
	author: one(pgUsers, {
		fields: [pgPosts.authorId],
		references: [pgUsers.id],
	}),
}));

const pgSchema = {
	users: pgUsers,
	posts: pgPosts,
	usersRelations: pgUsersRelations,
	postsRelations: pgPostsRelations,
};

describe('pg: getSelectSQL', () => {
	test('returns the wrapped expression for a column with selectFromDb', () => {
		const dialect = new PgDialect();
		const query = dialect.sqlToQuery(pgUsers.name.getSelectSQL()!);
		expect(query.sql).toBe('upper("users"."name")');
	});

	test('returns undefined for a custom column without selectFromDb', () => {
		const plain = pgCustomType<{ data: string; driverData: string }>({
			dataType: () => 'text',
		});
		const table = pgTable('plain', {
			id: serial('id').primaryKey(),
			name: plain('name'),
		});
		expect(table.name.getSelectSQL()).toBeUndefined();
	});
});

describe('pg: core queries (pg-proxy)', () => {
	function createDb(rows: any[][]) {
		const queries: string[] = [];
		const db = pgProxyDrizzle(async (queryString) => {
			queries.push(queryString);
			return { rows };
		}, { schema: pgSchema });
		return { db, queries };
	}

	test('full select wraps the column and decodes the wrapped value', async () => {
		const { db, queries } = createDb([[1, 'ALICE']]);
		const result = await db.select().from(pgUsers);
		expect(queries[0]).toBe('select "id", upper("name") from "users"');
		expect(result).toEqual([{ id: 1, name: 'alice' }]);
	});

	test('partial select wraps the column', async () => {
		const { db, queries } = createDb([['ALICE']]);
		const result = await db.select({ name: pgUsers.name }).from(pgUsers);
		expect(queries[0]).toBe('select upper("name") from "users"');
		expect(result).toEqual([{ name: 'alice' }]);
	});

	test('joined select qualifies the column inside the expression', async () => {
		const { db, queries } = createDb([[1, 'ALICE', 10, 'HELLO', 1]]);
		const result = await db.select().from(pgUsers).leftJoin(pgPosts, sql`${pgPosts.authorId} = ${pgUsers.id}`);
		expect(queries[0]).toContain('upper("users"."name")');
		expect(queries[0]).toContain('upper("posts"."title")');
		expect(result).toEqual([{
			users: { id: 1, name: 'alice' },
			posts: { id: 10, title: 'hello', authorId: 1 },
		}]);
	});

	test('insert returning wraps the column', async () => {
		const { db, queries } = createDb([[2, 'BOB']]);
		const result = await db.insert(pgUsers).values({ name: 'bob' }).returning();
		expect(queries[0]).toBe('insert into "users" ("id", "name") values (default, $1) returning "id", upper("name")');
		expect(result).toEqual([{ id: 2, name: 'bob' }]);
	});

	test('custom column without selectFromDb selects the plain column', async () => {
		const plain = pgCustomType<{ data: string; driverData: string }>({
			dataType: () => 'text',
			fromDriver: (value) => value.toLowerCase(),
		});
		const table = pgTable('plain_users', {
			id: serial('id').primaryKey(),
			name: plain('name').notNull(),
		});
		const queries: string[] = [];
		const db = pgProxyDrizzle(async (queryString) => {
			queries.push(queryString);
			return { rows: [[1, 'ALICE']] };
		});
		const result = await db.select().from(table);
		expect(queries[0]).toBe('select "id", "name" from "plain_users"');
		expect(result).toEqual([{ id: 1, name: 'alice' }]);
	});
});

describe('pg: relational queries (pg-proxy)', () => {
	test('findMany wraps the column and decodes the wrapped value', async () => {
		const queries: string[] = [];
		const db = pgProxyDrizzle(async (queryString) => {
			queries.push(queryString);
			return { rows: [[1, 'ALICE']] };
		}, { schema: pgSchema });
		const result = await db.query.users.findMany();
		expect(queries[0]).toBe('select "id", upper("name") from "users" "users"');
		expect(result).toEqual([{ id: 1, name: 'alice' }]);
	});

	test('nested relation wraps the column inside the json array', async () => {
		const queries: string[] = [];
		const db = pgProxyDrizzle(async (queryString) => {
			queries.push(queryString);
			return { rows: [[1, 'ALICE', [[10, 'HELLO', 1]]]] };
		}, { schema: pgSchema });
		const result = await db.query.users.findMany({ with: { posts: true } });
		expect(queries[0]).toContain('upper("users_posts"."title")');
		expect(result).toEqual([{
			id: 1,
			name: 'alice',
			posts: [{ id: 10, title: 'hello', authorId: 1 }],
		}]);
	});
});

const mysqlUpperText = mysqlCustomType<{ data: string; driverData: string }>({
	dataType: () => 'text',
	fromDriver: (value) => value.toLowerCase(),
	selectFromDb: (column) => sql`upper(${column})`,
});

const mysqlUsers = mysqlTable('users', {
	id: mysqlSerial('id').primaryKey(),
	name: mysqlUpperText('name').notNull(),
});

const mysqlPosts = mysqlTable('posts', {
	id: mysqlSerial('id').primaryKey(),
	title: mysqlUpperText('title').notNull(),
	authorId: mysqlInt('author_id'),
});

describe('mysql: core queries (mysql-proxy)', () => {
	test('full select wraps the column and decodes the wrapped value', async () => {
		const queries: string[] = [];
		const db = mysqlProxyDrizzle(async (queryString) => {
			queries.push(queryString);
			return { rows: [[1, 'ALICE']] };
		});
		const result = await db.select().from(mysqlUsers);
		expect(queries[0]).toBe('select `id`, upper(`name`) from `users`');
		expect(result).toEqual([{ id: 1, name: 'alice' }]);
	});

	test('joined select qualifies the column inside the expression', async () => {
		const queries: string[] = [];
		const db = mysqlProxyDrizzle(async (queryString) => {
			queries.push(queryString);
			return { rows: [[1, 'ALICE', 10, 'HELLO', 1]] };
		});
		const result = await db.select().from(mysqlUsers).leftJoin(
			mysqlPosts,
			sql`${mysqlPosts.authorId} = ${mysqlUsers.id}`,
		);
		expect(queries[0]).toContain('upper(`users`.`name`)');
		expect(queries[0]).toContain('upper(`posts`.`title`)');
		expect(result).toEqual([{
			users: { id: 1, name: 'alice' },
			posts: { id: 10, title: 'hello', authorId: 1 },
		}]);
	});
});

const sqliteUpperText = sqliteCustomType<{ data: string; driverData: string }>({
	dataType: () => 'text',
	fromDriver: (value) => value.toLowerCase(),
	selectFromDb: (column) => sql`upper(${column})`,
});

const sqliteUsers = sqliteTable('users', {
	id: sqliteInteger('id').primaryKey(),
	name: sqliteUpperText('name').notNull(),
});

const sqliteUsersRelations = relations(sqliteUsers, ({ many }) => ({}));

describe('sqlite: core and relational queries (sqlite-proxy)', () => {
	test('full select wraps the column and decodes the wrapped value', async () => {
		const queries: string[] = [];
		const db = sqliteProxyDrizzle(async (queryString) => {
			queries.push(queryString);
			return { rows: [[1, 'ALICE']] };
		});
		const result = await db.select().from(sqliteUsers);
		expect(queries[0]).toBe('select "id", upper("name") from "users"');
		expect(result).toEqual([{ id: 1, name: 'alice' }]);
	});

	test('relational findMany wraps the column', async () => {
		const queries: string[] = [];
		const db = sqliteProxyDrizzle(async (queryString) => {
			queries.push(queryString);
			return { rows: [[1, 'ALICE']] };
		}, { schema: { users: sqliteUsers, usersRelations: sqliteUsersRelations } });
		const result = await db.query.users.findMany();
		expect(queries[0]).toBe('select "id", upper("name") from "users" "users"');
		expect(result).toEqual([{ id: 1, name: 'alice' }]);
	});
});

const singlestoreUpperText = singlestoreCustomType<{ data: string; driverData: string }>({
	dataType: () => 'text',
	fromDriver: (value) => value.toLowerCase(),
	selectFromDb: (column) => sql`upper(${column})`,
});

const singlestoreUsers = singlestoreTable('users', {
	id: singlestoreSerial('id').primaryKey(),
	name: singlestoreUpperText('name').notNull(),
	otherId: singlestoreInt('other_id'),
});

describe('singlestore: core queries (singlestore-proxy)', () => {
	test('full select wraps the column and decodes the wrapped value', async () => {
		const queries: string[] = [];
		const db = singlestoreProxyDrizzle(async (queryString) => {
			queries.push(queryString);
			return { rows: [[1, 'ALICE', 5]] };
		});
		const result = await db.select().from(singlestoreUsers);
		expect(queries[0]).toBe('select `id`, upper(`name`), `other_id` from `users`');
		expect(result).toEqual([{ id: 1, name: 'alice', otherId: 5 }]);
	});
});

describe('gel: getSelectSQL', () => {
	test('returns the wrapped expression for a column with selectFromDb', () => {
		const gelUpperText = gelCustomType<{ data: string; driverData: string }>({
			dataType: () => 'text',
			selectFromDb: (column) => sql`upper(${column})`,
		});
		const table = gelTable('users', {
			id: gelInteger('id').primaryKey(),
			name: gelUpperText('name'),
		});
		const dialect = new GelDialect();
		const query = dialect.sqlToQuery(table.name.getSelectSQL()!);
		expect(query.sql).toBe('upper("users"."name")');
	});
});
