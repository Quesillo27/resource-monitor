package store

import "context"

func (s *Store) UpdateAgentTags(ctx context.Context, agentID string, tags []string) error {
	if tags == nil {
		tags = []string{}
	}
	_, err := s.pool.Exec(ctx,
		"UPDATE agents SET tags = $1, updated_at = now() WHERE id = $2::uuid",
		tags, agentID)
	return err
}

func (s *Store) ListAllTags(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		"SELECT DISTINCT unnest(tags) AS tag FROM agents WHERE cardinality(tags) > 0 ORDER BY tag")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tags []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}
