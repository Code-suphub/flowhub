use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    pub plugin: String,
    pub board_id: String,
    pub card_id: String,
    pub config: Value,
    pub title: String,
}

impl Request {
    pub fn validate(&self, layout: &super::Layout) -> Result<(), String> {
        if !self.config.is_object() || self.config.to_string().len() > 65536 || self.title.len() > 120 {
            return Err("详情配置或标题无效".into());
        }
        validate_source(layout, &self.board_id, &self.card_id, &self.plugin)
    }

    fn identity(&self) -> String {
        // Missing selection and explicit null represent distinct targets. Canonicalize
        // recursively rather than relying on serde_json's map implementation.
        fn canonical(value: &Value) -> Value {
            match value {
                Value::Object(map) => {
                    let sorted: std::collections::BTreeMap<_, _> = map.iter().map(|(k,v)| (k.clone(), canonical(v))).collect();
                    json!(sorted)
                }
                Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
                value => value.clone(),
            }
        }
        json!([self.board_id, self.card_id, self.plugin, self.config.get("selection").map(canonical)]).to_string()
            + if self.config.get("selection").is_some() { ":selected" } else { ":card" }
    }
}

pub(super) fn validate_source(layout: &super::Layout, board: &str, card: &str, plugin: &str) -> Result<(), String> {
    if layout.boards.iter().find(|b| b.id == board).and_then(|b| b.cards.iter().find(|c| c.id == card))
        .is_some_and(|c| c.plugin == plugin) { Ok(()) } else { Err("来源组件已移除或更换插件".into()) }
}

#[derive(Clone)]
pub(super) struct Entry {
    identity: String,
    pub request: Request,
    pub context: Value,
    pub revision: u64,
    ready: tokio::sync::watch::Sender<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReturnTarget {
    pub board_id: String,
    pub card_id: String,
    pub plugin: String,
    pub request_id: String,
    pub invalid: bool,
}

pub(super) enum Reservation {
    Create(String),
    Existing(String, tokio::sync::watch::Receiver<bool>),
}

#[derive(Default)]
pub(super) struct Registry {
    entries: HashMap<String, Entry>,
    identities: HashMap<String, String>,
    serial: u64,
}

impl Registry {
    pub fn return_target(&mut self, request: &Request, invalid: bool) -> ReturnTarget {
        self.serial += 1;
        ReturnTarget { board_id: request.board_id.clone(), card_id: request.card_id.clone(), plugin: request.plugin.clone(), request_id: format!("return-{}", self.serial), invalid }
    }

    pub fn get(&self, label: &str) -> Result<&Entry, String> {
        self.entries.get(label).ok_or_else(|| "详情来源无效".into())
    }

    pub fn owns(&self, label: &str, plugin: &str) -> bool {
        self.entries.get(label).is_some_and(|e| e.request.plugin == plugin)
    }

    pub fn reserve(&mut self, request: Request, snapshot: Value) -> Reservation {
        let identity = request.identity();
        let context = json!({"config":request.config,"title":request.title,"snapshot":snapshot});
        if let Some(label) = self.identities.get(&identity) {
            let entry = self.entries.get_mut(label).expect("registered identity");
            entry.request = request;
            entry.context = context;
            entry.revision += 1;
            return Reservation::Existing(label.clone(), entry.ready.subscribe());
        }
        self.serial += 1;
        let label = format!("widget-detail-{}", self.serial);
        let (ready, _) = tokio::sync::watch::channel(false);
        self.entries.insert(label.clone(), Entry { identity: identity.clone(), request, context, revision: 1, ready });
        self.identities.insert(identity, label.clone());
        Reservation::Create(label)
    }

    pub fn complete(&self, label: &str) -> Result<(), String> {
        self.get(label)?.ready.send_replace(true);
        Ok(())
    }

    pub fn remove(&mut self, label: &str) {
        if let Some(entry) = self.entries.remove(label) {
            self.identities.remove(&entry.identity);
            // Wake all concurrent callers, which then observe the missing entry.
            entry.ready.send_replace(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(config: Value) -> Request {
        Request { plugin:"machines".into(), board_id:"board".into(), card_id:"card".into(), config, title:"CPU".into() }
    }
    #[test]
    fn identity_uses_source_and_canonical_selection_only() {
        let a = request(json!({"selection":{"z":1,"a":{"b":2,"a":3}},"metrics":["cpu"]}));
        let mut b = request(serde_json::from_str(r#"{"selection":{"a":{"a":3,"b":2},"z":1},"metrics":["ram"]}"#).unwrap());
        assert_eq!(a.identity(), b.identity());
        b.card_id="other".into(); assert_ne!(a.identity(), b.identity());
        b=a.clone(); b.board_id="other".into(); assert_ne!(a.identity(), b.identity());
        b=a.clone(); b.plugin="other".into(); assert_ne!(a.identity(), b.identity());
        assert_ne!(request(json!({})).identity(), request(json!({"selection":null})).identity());
        assert_ne!(request(json!({"selection":[1,2]})).identity(), request(json!({"selection":[2,1]})).identity());
    }
    #[tokio::test]
    async fn pending_reservations_share_latest_context_and_cleanup_wakes_waiters() {
        let mut registry=Registry::default();
        let Reservation::Create(label)=registry.reserve(request(json!({})), json!({"cpu":1})) else { panic!() };
        let mut updated=request(json!({"metrics":["ram"]})); updated.title="RAM".into();
        let Reservation::Existing(same, mut ready)=registry.reserve(updated, json!({"cpu":2})) else { panic!() };
        assert_eq!(label,same); assert!(!*ready.borrow());
        registry.complete(&label).unwrap(); ready.changed().await.unwrap();
        assert_eq!(registry.get(&label).unwrap().revision,2);
        assert_eq!(registry.get(&label).unwrap().context["snapshot"]["cpu"],2);
        assert_eq!(registry.get(&label).unwrap().request.title,"RAM");
        assert!(registry.owns(&label,"machines")); assert!(!registry.owns(&label,"other"));
        registry.remove(&label); assert!(registry.get(&label).is_err());
        let Reservation::Create(next)=registry.reserve(request(json!({})), Value::Null) else { panic!() };
        assert_ne!(label,next);
        let Reservation::Existing(_,mut pending)=registry.reserve(request(json!({})),Value::Null) else { panic!() };
        registry.remove(&next); pending.changed().await.unwrap();
        assert!(registry.get(&next).is_err());
        assert!(matches!(registry.reserve(request(json!({})),Value::Null),Reservation::Create(_)));
    }

    #[test]
    fn concurrent_openers_reserve_one_window_and_isolate_plugin_rpc() {
        let registry=std::sync::Arc::new(std::sync::Mutex::new(Registry::default()));
        let barrier=std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers:Vec<_>=(0..8).map(|index|{
            let registry=registry.clone();let barrier=barrier.clone();
            std::thread::spawn(move||{
                barrier.wait();
                let mut req=request(json!({"selection":{"host":"a"},"metric":index}));
                req.title=format!("CPU {index}");
                registry.lock().unwrap().reserve(req,json!({"index":index}))
            })
        }).collect();
        let reservations:Vec<_>=workers.into_iter().map(|w|w.join().unwrap()).collect();
        let created:Vec<_>=reservations.iter().filter_map(|r|match r {Reservation::Create(label)=>Some(label),_=>None}).collect();
        assert_eq!(created.len(),1);
        let registry=registry.lock().unwrap();let label=created[0];
        for reservation in &reservations {
            let other=match reservation {Reservation::Create(label)|Reservation::Existing(label,_)=>label};
            assert_eq!(label,other);
        }
        let entry=registry.get(label).unwrap();assert_eq!(entry.revision,8);
        assert_eq!(entry.context["config"]["metric"],entry.context["snapshot"]["index"]);
        assert!(registry.owns(label,"machines"));assert!(!registry.owns(label,"other"));
        for external in ["settings","plugin-canvas","unknown-detail"] {
            assert!(registry.get(external).is_err());assert!(!registry.owns(external,"machines"));
        }
    }

    #[test]
    fn return_targets_bind_plugin_and_have_unique_request_ids() {
        let mut registry=Registry::default();
        let request=request(json!({}));
        let a=registry.return_target(&request,false);
        let b=registry.return_target(&request,true);
        assert_ne!(a.request_id,b.request_id);
        let payload=serde_json::to_value(&b).unwrap();
        assert_eq!(payload["boardId"],"board");assert_eq!(payload["cardId"],"card");
        assert_eq!(payload["plugin"],"machines");assert_eq!(payload["invalid"],true);
        assert_eq!(payload["requestId"],b.request_id);
    }
}
