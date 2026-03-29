import { type Folder, Policy } from "@cap/web-domain";
import { Effect } from "effect";

import { Database } from "../Database.ts";
import { FoldersRepo } from "./FoldersRepo.ts";

export class FoldersPolicy extends Effect.Service<FoldersPolicy>()(
	"FoldersPolicy",
	{
		effect: Effect.gen(function* () {
			const repo = yield* FoldersRepo;

			const canEdit = (id: Folder.FolderId) =>
				Policy.policy((user) =>
					Effect.gen(function* () {
						const folder = yield* (yield* repo.getById(id)).pipe(
							Effect.catchTag(
								"NoSuchElementException",
								() => new Policy.PolicyDeniedError(),
							),
						);

						return folder.createdById === user.id;
					}),
				);

			return { canEdit };
		}),
		dependencies: [FoldersRepo.Default, Database.Default],
	},
) {}
