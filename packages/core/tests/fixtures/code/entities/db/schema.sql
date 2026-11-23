-- CREATE TABLE not_a_table (id int);
CREATE TABLE users (
  id serial PRIMARY KEY,
  email text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.orders (
  id serial PRIMARY KEY,
  user_id int REFERENCES users (id)
);

CREATE TEMP TABLE "Tmp Cache" (k text);

CREATE VIEW recent_orders AS SELECT * FROM public.orders;

INSERT INTO users (email) VALUES ('CREATE TABLE fake (x int)');
