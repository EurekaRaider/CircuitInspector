use circuit_inspector_core::server::run_stdio_server;
use std::io;

fn main() {
    if let Err(error) = run_stdio_server(io::stdin().lock(), io::stdout().lock()) {
        eprintln!("CircuitInspector core stopped: {error}");
        std::process::exit(1);
    }
}
