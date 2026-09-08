UPDATE evidence_links
SET locator_json = json_object('type', 'url', 'value', source_url)
WHERE locator_json IS NULL
   OR json_extract(locator_json, '$.value') IS NULL
   OR trim(json_extract(locator_json, '$.value')) = '';

UPDATE evidence_links
SET article_revision_id = (
  SELECT ar.id
  FROM articles a
  JOIN article_revisions ar ON ar.article_id = a.id
  WHERE a.url = evidence_links.source_url
  ORDER BY ar.revision DESC
  LIMIT 1
)
WHERE article_revision_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM articles a
    JOIN article_revisions ar ON ar.article_id = a.id
    WHERE a.url = evidence_links.source_url
  );
