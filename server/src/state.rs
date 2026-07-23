//! Geteilter Anwendungszustand. Cheap-clonebar (Arc-basiert intern).

use std::sync::Arc;

use crate::config::Config;
use crate::hub::Hub;
use redis::aio::ConnectionManager;
use sqlx::PgPool;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Config,
    pub pg: PgPool,
    pub redis: ConnectionManager,
    pub http: reqwest::Client,
    pub hub: Arc<Hub>,
}

impl AppState {
    pub fn redis(&self) -> ConnectionManager {
        self.redis.clone()
    }
}
