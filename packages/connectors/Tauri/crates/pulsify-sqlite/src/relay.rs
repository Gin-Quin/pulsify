//! `relay_frame` lives in `pulsify-protocol`; these tests run it on SQLite.
#[cfg(test)]
pub(crate) mod tests {
    use crate::store::tests::{next, row, A, B};
    use crate::{chunk_rows, relay_frame, SqliteStore};
    use pulsify_protocol::{
        decode, encode, Body, Message, PatchRow, VersionVector, MAX_MESSAGE_ROWS, MAX_PATCH_BYTES,
        MAX_VECTOR_ENTRIES,
    };

    pub fn frame(request_id: u64, body: Body) -> Vec<u8> {
        encode(&Message {
            doc_id: "doc".into(),
            request_id,
            body,
        })
        .unwrap()
    }
    pub fn connect(request_id: u64, vv: VersionVector) -> Vec<u8> {
        frame(request_id, Body::Connect { vv })
    }
    pub fn upload(request_id: u64, rows: Vec<PatchRow>) -> Vec<u8> {
        frame(request_id, Body::SyncBack { vv: vec![], rows })
    }
    fn bodies(frames: &[Vec<u8>]) -> Vec<(u64, Body)> {
        frames
            .iter()
            .map(|bytes| {
                let message = decode(bytes).unwrap();
                (message.request_id, message.body)
            })
            .collect()
    }

    #[test]
    fn connect_to_an_empty_document_returns_one_complete_page() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let output = relay_frame(&mut store, &connect(1, vec![]), Some("doc")).unwrap();
        assert_eq!(output.doc_id, "doc");
        assert!(output.broadcast.is_empty());
        assert_eq!(
            bodies(&output.responses),
            vec![(
                1,
                Body::Sync {
                    found: false,
                    complete: true,
                    vv: vec![],
                    rows: vec![]
                }
            )]
        );
    }

    #[test]
    fn uploads_are_acknowledged_broadcast_and_served() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let rows = vec![next(A, 1, 2), next(A, 3, 1)];
        let output = relay_frame(&mut store, &upload(2, rows.clone()), None).unwrap();
        assert_eq!(
            bodies(&output.responses),
            vec![(2, Body::Ack { vv: vec![(A, 4)] })]
        );
        assert_eq!(
            bodies(&output.broadcast),
            vec![(
                0,
                Body::Update {
                    vv: vec![(A, 4)],
                    rows: rows.clone()
                }
            )]
        );
        let update = frame(3, Body::Update { vv: vec![], rows });
        let again = relay_frame(&mut store, &update, None).unwrap();
        assert_eq!(
            bodies(&again.responses),
            vec![(3, Body::Ack { vv: vec![(A, 4)] })]
        );
        assert!(again.broadcast.is_empty());
        let sync = relay_frame(&mut store, &connect(4, vec![(A, 3)]), None).unwrap();
        assert_eq!(
            bodies(&sync.responses),
            vec![(
                4,
                Body::Sync {
                    found: true,
                    complete: true,
                    vv: vec![(A, 4)],
                    rows: vec![next(A, 3, 1)]
                }
            )]
        );
    }

    #[test]
    fn pending_rows_are_acknowledged_without_advancing_the_vector() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let output = relay_frame(&mut store, &upload(1, vec![next(A, 2, 1)]), None).unwrap();
        assert_eq!(
            bodies(&output.responses),
            vec![(1, Body::Ack { vv: vec![] })]
        );
        assert_eq!(output.broadcast.len(), 1);
        let output = relay_frame(&mut store, &upload(2, vec![next(A, 1, 1)]), None).unwrap();
        assert_eq!(
            bodies(&output.responses),
            vec![(2, Body::Ack { vv: vec![(A, 3)] })]
        );
    }

    #[test]
    fn failures_become_error_frames() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        relay_frame(&mut store, &upload(1, vec![next(A, 1, 2)]), None).unwrap();
        let mut changed = next(A, 1, 2);
        changed.operations = vec![7];
        let cases = [
            (upload(2, vec![next(B, 1, 1), changed]), None, "CONFLICT"),
            (connect(3, vec![]), Some("other"), "INVALID_MESSAGE"),
            (
                frame(4, Body::Ack { vv: vec![] }),
                Some("doc"),
                "INVALID_MESSAGE",
            ),
        ];
        for (bytes, pinned, expected) in cases {
            let output = relay_frame(&mut store, &bytes, pinned).unwrap();
            assert!(output.broadcast.is_empty());
            let [(_, Body::Error { code, .. })] = &bodies(&output.responses)[..] else {
                panic!("expected one error frame");
            };
            assert_eq!(code, expected);
        }
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 3)]);
        let error = relay_frame(&mut store, &[1, 3, 9], None).unwrap_err();
        assert_eq!(error.code, "INVALID_MESSAGE");
        let error = relay_frame(&mut store, &[9, 3, 1], None).unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_VERSION");
    }

    #[test]
    fn large_documents_are_paged() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let mut clock = 1;
        for _ in 0..3 {
            let rows: Vec<_> = (0..2)
                .map(|_| {
                    let mut segment = next(A, clock, 1);
                    segment.operations = vec![1; 700 * 1024];
                    clock += 1;
                    segment
                })
                .collect();
            relay_frame(&mut store, &upload(1, rows), None).unwrap();
        }
        let tiny: Vec<_> = (0..MAX_VECTOR_ENTRIES as u64 - 1)
            .map(|i| row(B + i, 1, 1, &[]))
            .collect();
        relay_frame(&mut store, &upload(2, tiny), None).unwrap();
        let output = relay_frame(&mut store, &connect(3, vec![]), None).unwrap();
        let pages = bodies(&output.responses);
        assert!(pages.len() >= 3);
        let mut total = 0;
        for (i, (request_id, body)) in pages.iter().enumerate() {
            let Body::Sync {
                found,
                complete,
                vv,
                rows,
            } = body
            else {
                panic!("expected sync pages");
            };
            assert_eq!(*request_id, 3);
            assert!(found);
            assert_eq!(*complete, i == pages.len() - 1);
            assert_eq!(vv.len(), MAX_VECTOR_ENTRIES);
            total += rows.len();
        }
        assert_eq!(total, 6 + MAX_VECTOR_ENTRIES - 1);
    }

    #[test]
    fn chunks_respect_row_count_and_size_budgets() {
        let rows: Vec<_> = (1..=MAX_MESSAGE_ROWS as u64 * 2 + 1)
            .map(|clock| next(A, clock, 1))
            .collect();
        let chunks = chunk_rows(rows);
        assert_eq!(
            chunks.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![MAX_MESSAGE_ROWS, MAX_MESSAGE_ROWS, 1]
        );
        let mut big = next(A, 1, 1);
        big.operations = vec![0; MAX_PATCH_BYTES];
        assert_eq!(chunk_rows(vec![big.clone(), big.clone(), big]).len(), 3);
        assert_eq!(chunk_rows(vec![]), vec![Vec::<PatchRow>::new()]);
    }
}
