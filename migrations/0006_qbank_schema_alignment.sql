-- Keep the service-data D1 schema aligned with the current QBank handlers.
ALTER TABLE papers_archive ADD COLUMN exam_semester TEXT;
ALTER TABLE papers_archive ADD COLUMN file_size INTEGER;
ALTER TABLE papers_archive ADD COLUMN storage_provider TEXT;

ALTER TABLE qbank_questions ADD COLUMN topic_name TEXT;
ALTER TABLE qbank_questions ADD COLUMN diagram_url TEXT;
