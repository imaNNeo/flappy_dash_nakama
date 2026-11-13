deployFromMain:
	git pull origin main
	cd data/modules/functions && make setupProject && make generateJS && cd ../../../
	docker compose pull
	docker compose up -d
	docker compose restart nakama
	echo "Deployed from main branch completed"

runLocally:
	cd data/modules/functions && make setupProject && make generateJS && cd ../../../
	docker compose up -d
	docker compose restart nakama
	docker compose logs -f nakama
