-- 0051_document_storage_limit: a project document's file counts against the workspace's storage (0020); a revision
-- is refused once the quota is used, like the assistant's exports.
CREATE TRIGGER document_revisions_storage_limit BEFORE INSERT ON document_revisions FOR EACH ROW EXECUTE FUNCTION enforce_storage_limit();
