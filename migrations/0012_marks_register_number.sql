-- Keep the verified register number alongside marks identity hashes.
ALTER TABLE class_user_marks ADD COLUMN reg_no TEXT;
