// Command gitfixture serves local bare repositories over git smart HTTP.
//
// TEST INFRASTRUCTURE ONLY. It lets the acceptance suite exercise the real
// clone -> build -> deploy path without network access to GitHub. It is never
// part of a production installation.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/the-null-catchers/deployforge/services/runner/internal/gitops"
)

func main() {
	root := flag.String("root", "/repos", "directory containing <owner>/<repo>.git bare repositories")
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()
	h, err := gitops.FixtureHandler(*root, os.Getenv("GIT_FIXTURE_TOKEN"))
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Addr: *addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("git fixture serving %s on %s", *root, *addr)
	log.Fatal(srv.ListenAndServe())
}
