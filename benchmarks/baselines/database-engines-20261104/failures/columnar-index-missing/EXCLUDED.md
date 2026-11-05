# Excluded: incomplete columnar index adaptation

After removing the unsupported columnar primary key, the adapter omitted a non-unique `(doc,sid,start)` index for point lookups. The end-range index only covered the first two point-lookup columns. This could penalize columnar duplicate checks and compaction source verification. The adapter is corrected and the retained matrices rerun. These diagnostics are not used for engine ranking.
