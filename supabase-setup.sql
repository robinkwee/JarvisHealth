-- Supabase Schema Setup
-- Copy and paste into Supabase SQL Editor and run

-- Users table (registration)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  kcal_target INT DEFAULT 2550,
  protein_target INT DEFAULT 140,
  carbs_target INT DEFAULT 325,
  fat_target INT DEFAULT 75,
  fiber_target INT DEFAULT 35,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Meals table
CREATE TABLE meals (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  date DATE NOT NULL,
  time TIME NOT NULL,
  description TEXT NOT NULL,
  calories INT,
  protein_g DECIMAL(5,1),
  carbs_g DECIMAL(5,1),
  fat_g DECIMAL(5,1),
  fiber_g DECIMAL(5,1),
  photo_msg_id INT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE meals ENABLE ROW LEVEL SECURITY;

-- RLS Policies - allow anon to read/write
CREATE POLICY "Allow anon insert on users" ON users FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon insert on meals" ON meals FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon select on users" ON users FOR SELECT USING (true);
CREATE POLICY "Allow anon select on meals" ON meals FOR SELECT USING (true);
