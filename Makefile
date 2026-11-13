default: help

.PHONY: help
help: # Show help for each of the Makefile recipes
	@grep -E '^[a-z0-9-]+:.*#' Makefile | awk 'BEGIN{FS=":.*# ?"} {printf "\033[1;32m%-8s\033[0m %s\n", $$1, $$2}'

UNAME := $(shell uname -s 2>/dev/null)

.PHONY: setup
setup: # Install or update to the latest LTS Node.js, then the dependencies, the newest pdf.js and the text-box fonts (scripts/pdfjs.mjs)
ifeq ($(UNAME),Darwin)
	brew install node 2>/dev/null || brew upgrade node
else ifeq ($(UNAME),Linux)
	command -v npm >/dev/null || curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | sudo bash -s lts
	sudo npm install -g n npm@latest && sudo n lts
else
	$(error Windows: install Node.js LTS from https://nodejs.org, then run 'npm install')
endif
	npm install --no-audit --no-fund --loglevel=error

.PHONY: example
example: # Regenerate resources/example.pdf
	npm run compile && node scripts/example.mjs

.PHONY: media
media: # Re-record banner.gif and the screenshots in resources/media in a real VS Code (PDF_VSCODE off macOS)
	npm run compile && node scripts/media.mjs

.PHONY: clean
clean: # Remove all generated files (compiled output, coverage, extension packages)
	rm -rf out dist coverage *.vsix
