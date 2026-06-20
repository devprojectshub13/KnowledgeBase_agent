// Update.exe — one-click updater for non-technical clients.
//
// Lives next to docker-compose.yml in the deployment folder. Double-clicking it
// fetches the newest app image, recreates the container, and removes the old
// (now-dangling) image. Data is never touched: image prune only removes
// untagged images — the Postgres volume and ./invoice_data bind mount survive.
package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

const appURL = "http://localhost:9000"

func main() {
	// Run in the folder this program lives in (where docker-compose.yml is),
	// not whatever directory Windows happened to launch it from.
	if dir, err := exeDir(); err == nil {
		_ = os.Chdir(dir)
	}

	line()
	fmt.Println("   Finance Agent — Update")
	line()
	fmt.Println()

	if !dockerReady() {
		fail("Docker isn't running yet.\n\n" +
			"  Please open Docker Desktop, wait until it says \"running\",\n" +
			"  then double-click Update again.")
	}

	steps := []struct {
		msg  string
		args []string
	}{
		{"Downloading the latest version...", []string{"compose", "pull"}},
		{"Applying the update...", []string{"compose", "up", "-d"}},
		{"Removing the old version (your data is kept)...", []string{"image", "prune", "-f"}},
	}
	for _, s := range steps {
		fmt.Println("-> " + s.msg)
		if err := run("docker", s.args...); err != nil {
			fail("Something went wrong while updating.\n\n" +
				"  Details: " + err.Error() + "\n\n" +
				"  Please try again. If it keeps failing, contact support.")
		}
		fmt.Println()
	}

	line()
	fmt.Println("   Finance Agent is up to date!")
	fmt.Println("   Opening " + appURL)
	line()
	openBrowser(appURL)
	pause("\nAll done. Press Enter to close this window.")
}

func exeDir() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Dir(p), nil
}

// dockerReady reports whether the Docker engine is up, quietly (no output).
func dockerReady() bool {
	cmd := exec.Command("docker", "info")
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run() == nil
}

// run executes a command and streams its output so the user sees progress.
func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func openBrowser(url string) {
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("cmd", "/c", "start", "", url).Start()
	case "darwin":
		_ = exec.Command("open", url).Start()
	default:
		_ = exec.Command("xdg-open", url).Start()
	}
}

func line() {
	fmt.Println("============================================")
}

func fail(msg string) {
	fmt.Println()
	fmt.Println("  " + msg)
	pause("\nPress Enter to close this window.")
	os.Exit(1)
}

func pause(prompt string) {
	fmt.Println(prompt)
	bufio.NewReader(os.Stdin).ReadString('\n') //nolint:errcheck
}
