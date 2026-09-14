-- Make migrations self-contained: the pgvector type must exist before 0002
-- creates a vector column. Previously check_setup created it, but the container
-- runs only migrations, so it belongs here. Runs as the owner role.

create extension if not exists vector;
